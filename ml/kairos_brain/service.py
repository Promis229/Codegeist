"""Service d'inférence Kairos Brain (FastAPI). Déployé séparément du backend ; le backend l'appelle en HTTP.

Variables d'environnement :
  KAIROS_ML_API_KEY    clé partagée avec le backend (en-tête Authorization: Bearer …). Obligatoire hors développement.
  KAIROS_MODELS_DIR    dossier du modèle entraîné (par défaut ./models)
  KAIROS_EMBED_MODEL   modèle de plongement (par défaut paraphrase-multilingual-MiniLM-L12-v2)
  KAIROS_EMBEDDER=hash plongement de test (CI sans réseau uniquement)

Contrat : si une tâche n'a pas franchi sa barrière de qualité à l'entraînement, le service répond 503 pour elle ; le backend
retombe alors sur son algorithme lexical. On ne sert jamais un modèle qui ne bat pas sa référence.
"""
from __future__ import annotations

import hmac
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import joblib
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import __version__
from .config import BUNDLE_NAME, MAX_CANDIDATES, MAX_TEXT_CHARS, MODELS_DIR, PRIORITIES, QUANTILES
from .data import creation_features, tabular_features, ticket_text
from .embedder import make_embedder

STATE: dict = {"embedder": None, "bundle": None, "loaded": False, "lock": threading.Lock()}


def _load() -> None:
    with STATE["lock"]:
        if STATE["loaded"]:
            return
        STATE["embedder"] = make_embedder()
        p = Path(os.environ.get("KAIROS_MODELS_DIR", MODELS_DIR)) / BUNDLE_NAME
        STATE["bundle"] = joblib.load(p) if p.exists() else None
        STATE["loaded"] = True


@asynccontextmanager
async def lifespan(_: FastAPI):
    _load()
    yield


app = FastAPI(title="Kairos Brain", version=__version__, lifespan=lifespan)


def auth(authorization: str | None = Header(default=None)) -> None:
    key = os.environ.get("KAIROS_ML_API_KEY", "")
    if not key:
        if os.environ.get("KAIROS_ENV") == "production":
            raise HTTPException(503, "KAIROS_ML_API_KEY n'est pas configurée : le service refuse de répondre sans clé en production")
        return  # développement local uniquement
    sent = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(sent.encode(), key.encode()):
        raise HTTPException(401, "clé invalide")


def _passed(task: str) -> bool:
    b = STATE["bundle"]
    return bool(b and b["card"]["gates"].get(task, {}).get("passed"))


def _need(task: str) -> dict:
    b = STATE["bundle"]
    if not b:
        raise HTTPException(503, "aucun modèle entraîné")
    if not _passed(task):
        raise HTTPException(503, f"la tâche « {task} » n'a pas franchi la barrière de qualité : {b['card']['gates'].get(task, {}).get('reason', 'inconnue')}")
    return b


def _model_info() -> dict:
    b, e = STATE["bundle"], STATE["embedder"]
    c = b["card"] if b else {}
    return {"name": "kairos-brain", "version": __version__, "embedding_model": getattr(e, "model_name", None), "trained_at": c.get("trained_at"), "n_train": c.get("n_train"),
            "data_fingerprint": c.get("data_fingerprint")}


# ------------------------------------------------------------------------------------------------ schémas
class Candidate(BaseModel):
    id: str
    text: str = Field(max_length=4000)
    lang: str | None = None


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    candidates: list[Candidate] = Field(max_length=MAX_CANDIDATES)
    top_k: int = Field(default=8, ge=1, le=50)


class TriageIn(BaseModel):
    title: str = Field(max_length=500)
    body: str = Field(default="", max_length=8000)
    tier: str | None = None
    channel: str | None = None


class RiskIn(BaseModel):
    title: str = Field(max_length=500)
    body: str = Field(default="", max_length=8000)
    component: str | None = None
    priority: str = "medium"
    channel: str | None = "portal"
    tier: str | None = "standard"
    frustration: float = 0.0
    sentiment: float = 0.0
    sla_hours: float | None = None


# ------------------------------------------------------------------------------------------------ routes
@app.get("/health")
def health() -> dict:
    return {"status": "ok", "ready": STATE["loaded"], "model_loaded": STATE["bundle"] is not None}


@app.get("/v1/model", dependencies=[Depends(auth)])
def model() -> dict:
    b = STATE["bundle"]
    info = _model_info()
    if b:
        c = b["card"]
        info.update({"languages": c["languages"], "gates": c["gates"], "retrieval": c.get("retrieval"), "caveats": c.get("caveats"),
                     "metrics": {k: v.get("cv") for k, v in c["tasks"].items()}})
    return info


@app.post("/v1/reload", dependencies=[Depends(auth)])
def reload_model() -> dict:
    """Recharge le modèle depuis le disque après un ré-entraînement, sans redémarrer le service ni couper le trafic."""
    p = Path(os.environ.get("KAIROS_MODELS_DIR", MODELS_DIR)) / BUNDLE_NAME
    if not p.exists():
        raise HTTPException(404, "aucun modèle sur le disque")
    new = joblib.load(p)
    with STATE["lock"]:
        STATE["bundle"] = new
    return {"reloaded": True, "model": _model_info()}


@app.post("/v1/embed", dependencies=[Depends(auth)])
def embed(payload: dict) -> dict:
    texts = [str(t)[:MAX_TEXT_CHARS] for t in payload.get("texts", [])][:256]
    v = STATE["embedder"].encode(texts)
    return {"dim": int(v.shape[1]) if len(v) else 0, "vectors": v.round(5).tolist(), "model": STATE["embedder"].model_name}


@app.post("/v1/search", dependencies=[Depends(auth)])
def search(p: SearchIn) -> dict:
    """Recherche sémantique multilingue : classe les candidats par similarité cosinus avec la requête."""
    emb = STATE["embedder"]
    q = emb.encode([p.query[:MAX_TEXT_CHARS]])[0]
    C = emb.encode([c.text[:MAX_TEXT_CHARS] for c in p.candidates]) if p.candidates else np.zeros((0, q.shape[0]), dtype=np.float32)
    scores = C @ q if len(C) else np.array([])
    order = np.argsort(-scores)[: p.top_k]
    return {"model": emb.model_name, "results": [{"id": p.candidates[i].id, "score": round(float(scores[i]), 4)} for i in order]}


def _neighbors(vec: np.ndarray, k: int = 3) -> list[dict]:
    idx = STATE["bundle"]["index"]
    sims = idx["emb"] @ vec
    out = []
    for i in np.argsort(-sims)[:k]:
        m = idx["meta"][int(i)]
        out.append({"key": m["key"], "title": m["title"], "priority": m["priority"], "component": m["component"], "resolution_hours": m["resolution_hours"], "score": round(float(sims[i]), 3)})
    return out


@app.post("/v1/predict/triage", dependencies=[Depends(auth)])
def triage(p: TriageIn) -> dict:
    """Priorité et composant probables, avec les cas passés les plus proches comme preuve."""
    b = STATE["bundle"]
    if not b:
        raise HTTPException(503, "aucun modèle entraîné")
    import pandas as pd

    v = STATE["embedder"].encode([ticket_text(p.title, p.body)])[0]
    out: dict = {"model": _model_info()}
    if _passed("priority"):
        m = b["priority"]
        # même variables qu'à l'entraînement : plongement + offre du client + canal (connus à la création, jamais la priorité)
        feats = creation_features(pd.DataFrame([{"tier": p.tier or "standard", "channel": p.channel or "portal"}]))
        pr = m.predict_proba(np.hstack([v.reshape(1, -1), feats]))[0]
        probs = {str(c): round(float(x), 4) for c, x in zip(m.classes_, pr)}
        out["priority"] = {"label": max(probs, key=probs.get), "probabilities": probs}
    else:
        raise HTTPException(503, f"la tâche « priority » n'a pas franchi la barrière de qualité : {b['card']['gates']['priority']['reason']}")
    if _passed("component") and b["component"] is not None:
        m = b["component"]
        pc = m.predict_proba(v.reshape(1, -1))[0]
        cp = {str(c): round(float(x), 4) for c, x in zip(m.classes_, pc)}
        out["component"] = {"label": max(cp, key=cp.get), "probabilities": cp}
    out["evidence"] = _neighbors(v)
    return out


def _p_exceed(qs: np.ndarray, hours: float) -> float:
    """P(durée > hours) par interpolation linéaire de la fonction de répartition passant par les quantiles prédits."""
    xs = np.concatenate([[0.0], qs, [qs[-1] * 2 + 1]])
    ys = np.concatenate([[0.0], QUANTILES, [1.0]])
    return float(np.clip(1 - np.interp(hours, xs, ys), 0, 1))


@app.post("/v1/predict/risk", dependencies=[Depends(auth)])
def risk(p: RiskIn) -> dict:
    """Délai de résolution (quantiles), risque de réouverture et probabilité de dépasser le SLA."""
    import pandas as pd

    b = STATE["bundle"]
    if not b:
        raise HTTPException(503, "aucun modèle entraîné")
    v = STATE["embedder"].encode([ticket_text(p.title, p.body)])[0]
    df = pd.DataFrame([{"priority": p.priority, "tier": p.tier or "standard", "channel": p.channel or "portal", "frustration": p.frustration, "sentiment": p.sentiment}])
    X = np.hstack([v.reshape(1, -1), tabular_features(df)])
    out: dict = {"model": _model_info(), "evidence": _neighbors(v)}
    served = False
    if _passed("resolution_time") and b["resolution"]:
        ct, ms = b["resolution"]["ct"], b["resolution"]["models"]
        Z = ct.transform(X)
        qs = np.sort(np.expm1(np.array([ms[q].predict(Z)[0] for q in QUANTILES])))
        out["resolution_hours"] = {"p10": round(float(qs[0]), 1), "p25": round(float(qs[1]), 1), "p50": round(float(qs[2]), 1), "p75": round(float(qs[3]), 1), "p90": round(float(qs[4]), 1), "p95": round(float(qs[5]), 1)}
        if p.sla_hours:
            out["sla_breach_probability"] = round(_p_exceed(qs, p.sla_hours), 3)
        served = True
    if _passed("reopen_risk") and b["reopen"] is not None:
        out["reopen_probability"] = round(float(b["reopen"].predict_proba(X)[0, 1]), 3)
        served = True
    if not served:
        raise HTTPException(503, "aucun modèle de risque n'a franchi la barrière de qualité")
    return out
