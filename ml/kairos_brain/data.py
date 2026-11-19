"""Récupération et mise en forme des données depuis le backend Kairos."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from .config import CHANNELS, PRIORITIES, TIERS


def fetch_export(base_url: str, api_key: str, limit: int = 5000, timeout: int = 60) -> dict:
    """Télécharge le jeu d'entraînement (textes déjà masqués côté backend). Nécessite une clé d'API `admin`."""
    url = f"{base_url.rstrip('/')}/api/v1/ml/export"
    r = requests.get(url, params={"limit": limit}, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout)
    if r.status_code == 403:
        raise PermissionError("L'export d'entraînement exige un compte ou une clé d'API de portée « admin ».")
    r.raise_for_status()
    return r.json()


def load_export(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_export(export: dict, path: str | Path) -> None:
    Path(path).write_text(json.dumps(export, ensure_ascii=False), encoding="utf-8")


def ticket_text(title: str, body: str, limit: int = 700) -> str:
    return f"{title}. {body}".strip()[:limit]


def tickets_frame(export: dict) -> pd.DataFrame:
    """DataFrame des demandes avec les variables dérivées utilisées par les modèles."""
    df = pd.DataFrame(export["tickets"])
    df["text"] = [ticket_text(t, b) for t, b in zip(df["title"], df["body"])]
    df["tier"] = df["tier"].fillna("standard")
    df["channel"] = df["channel"].fillna("portal")
    df["component"] = df["component"].fillna("")
    for c in ("frustration", "sentiment"):
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0.0)
    df["resolution_hours"] = pd.to_numeric(df["resolution_hours"], errors="coerce")
    df["reopened"] = df["reopened"].astype(bool)
    return df


def tabular_features(df: pd.DataFrame) -> np.ndarray:
    """Variables non textuelles : priorité, offre, canal (one-hot), frustration, ton."""
    def onehot(col: str, values: list[str]) -> np.ndarray:
        return np.stack([(df[col] == v).to_numpy(dtype=np.float32) for v in values], axis=1)

    return np.hstack([
        onehot("priority", PRIORITIES), onehot("tier", TIERS), onehot("channel", CHANNELS),
        df[["frustration", "sentiment"]].to_numpy(dtype=np.float32),
    ])


def creation_features(df: pd.DataFrame) -> np.ndarray:
    """Variables connues AU MOMENT de la création (offre du client, canal). Jamais la priorité elle-même : ce serait une fuite."""
    def onehot(col: str, values: list[str]) -> np.ndarray:
        return np.stack([(df[col] == v).to_numpy(dtype=np.float32) for v in values], axis=1)

    return np.hstack([onehot("tier", TIERS), onehot("channel", CHANNELS)])


def fingerprint(df: pd.DataFrame) -> str:
    """Empreinte du jeu d'entraînement (identifiants + cibles, jamais le contenu) : prouve ce sur quoi le modèle a appris."""
    import hashlib

    h = hashlib.sha256()
    for row in df.sort_values("id")[["id", "priority", "component", "resolution_hours", "reopened"]].itertuples(index=False):
        h.update(repr(tuple(row)).encode())
    return h.hexdigest()[:16]
