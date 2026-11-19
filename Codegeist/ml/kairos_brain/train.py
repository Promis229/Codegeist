"""Entraînement et évaluation des modèles Kairos Brain.

Principe : un plongement multilingue pré-entraîné (gelé) + des « têtes » légères apprises sur VOS demandes. Avantages :
robuste avec peu de données (quelques centaines d'exemples suffisent), entraînement en secondes sur CPU, ré-entraînable
chaque nuit, et prédictions explicables par les cas passés les plus proches.

Rigueur de l'évaluation (c'est ce qui sépare un vrai modèle d'une démonstration) :
  * validation croisée IMBRIQUÉE : les hyperparamètres sont choisis sans jamais voir le pli de test ;
  * références simples : un modèle qui ne les bat pas ne vaut rien ;
  * test de PERMUTATION : le modèle doit faire mieux que ce que donnent ses propres étiquettes mélangées (sinon il a
    seulement « appris le bruit ») ;
  * intervalle de confiance bootstrap pour le gain sur le délai de résolution.
La barrière de qualité (apply_gates) n'active un modèle que s'il passe tous ces contrôles.
"""
from __future__ import annotations

import json
import platform
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import sklearn
from scipy import sparse
from sklearn.compose import ColumnTransformer
from sklearn.decomposition import PCA
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, average_precision_score, confusion_matrix, f1_score, log_loss, roc_auc_score
from sklearn.model_selection import KFold, StratifiedKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from . import __version__
from .config import BUNDLE_NAME, CARD_NAME, MODELS_DIR, PRIORITIES, QUANTILES, SEED
from .data import creation_features, fingerprint, tabular_features, tickets_frame
from .embedder import Embedder, make_embedder

N_PERMUTATIONS = 25
GRID = [(C, cw) for C in (0.5, 2.0, 8.0, 32.0) for cw in (None, "balanced")]


def _strip(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def _splits(y: np.ndarray, k: int = 5):
    _, counts = np.unique(y, return_counts=True)
    n = int(min(k, counts.min()))
    return StratifiedKFold(n_splits=n, shuffle=True, random_state=SEED) if n >= 2 else KFold(n_splits=min(k, len(y)), shuffle=True, random_state=SEED)


def _fill(out: np.ndarray, rows: np.ndarray, model, p: np.ndarray, classes: np.ndarray) -> None:
    for j, c in enumerate(model.classes_):
        out[rows, int(np.where(classes == c)[0][0])] = p[:, j]


def _oof(make, X, y: np.ndarray, classes: np.ndarray, k: int = 5) -> np.ndarray:
    """Probabilités hors-échantillon : chaque exemple est prédit par un modèle qui ne l'a jamais vu."""
    out = np.zeros((len(y), len(classes)))
    for tr, te in _splits(y, k).split(np.zeros(len(y)), y):
        m = make().fit(X[tr], y[tr])
        _fill(out, te, m, m.predict_proba(X[te]), classes)
    return out


def _select(X: np.ndarray, y: np.ndarray, classes: np.ndarray) -> tuple[float, str | None]:
    """Choix des hyperparamètres par validation croisée INTERNE (sur le jeu d'apprentissage seulement)."""
    best = None
    for C, cw in GRID:
        proba = _oof(lambda C=C, cw=cw: LogisticRegression(C=C, class_weight=cw, max_iter=3000), X, y, classes, k=3)
        f1 = f1_score(y, classes[proba.argmax(1)], average="macro")
        if best is None or f1 > best[0]:
            best = (f1, C, cw)
    return best[1], best[2]


def _nested(X: np.ndarray, y: np.ndarray, classes: np.ndarray) -> np.ndarray:
    """Validation croisée IMBRIQUÉE : le choix des hyperparamètres ne voit jamais le pli de test (pas d'optimisme)."""
    out = np.zeros((len(y), len(classes)))
    for tr, te in _splits(y).split(np.zeros(len(y)), y):
        C, cw = _select(X[tr], y[tr], classes)
        m = LogisticRegression(C=C, class_weight=cw, max_iter=3000).fit(X[tr], y[tr])
        _fill(out, te, m, m.predict_proba(X[te]), classes)
    return out


def _permutation_p(make, X, y: np.ndarray, classes: np.ndarray, real: float, score) -> float:
    """p-valeur : avec des étiquettes mélangées, combien de fois fait-on aussi bien que le vrai modèle ?"""
    rng = np.random.default_rng(SEED)
    hits = 0
    for _ in range(N_PERMUTATIONS):
        yp = rng.permutation(y)
        hits += score(yp, _oof(make, X, yp, classes)) >= real
    return (1 + hits) / (N_PERMUTATIONS + 1)


# ---------------------------------------------------------------------------------------------- classifieurs
def train_classifier(name: str, X: np.ndarray, y: np.ndarray, texts: list[str], extra: np.ndarray | None = None, min_count: int = 3) -> tuple[LogisticRegression | None, dict]:
    """`extra` : variables connues à la création (offre, canal), ajoutées au modèle ET à la référence TF-IDF (comparaison équitable)."""
    labels, counts = np.unique(y, return_counts=True)
    keep = np.isin(y, labels[counts >= min_count])
    if keep.sum() < 20 or len(np.unique(y[keep])) < 2:
        return None, {"task": name, "skipped": "pas assez d'exemples"}
    X, y = X[keep], y[keep]
    texts = [t for t, k in zip(texts, keep) if k]
    extra = extra[keep] if extra is not None else None
    Xf = np.hstack([X, extra]) if extra is not None else X
    classes = np.unique(y)

    proba = _nested(Xf, y, classes)
    pred = classes[proba.argmax(1)]
    f1 = float(f1_score(y, pred, average="macro"))
    C, cw = _select(Xf, y, classes)  # hyperparamètres du modèle final : choisis sur toutes les données, évalués par la CV imbriquée ci-dessus

    # références : classe majoritaire, TF-IDF + régression logistique (lexical classique, avec les mêmes variables de création)
    maj = classes[np.argmax([(y == c).sum() for c in classes])]
    ta = np.array(texts, dtype=object)
    tf_proba = np.zeros_like(proba)
    for tr, te in _splits(y).split(np.zeros(len(y)), y):
        vec = TfidfVectorizer(preprocessor=_strip, ngram_range=(1, 2), sublinear_tf=True).fit(ta[tr])
        mk = lambda idx: sparse.hstack([vec.transform(ta[idx]), sparse.csr_matrix(extra[idx])]).tocsr() if extra is not None else vec.transform(ta[idx])
        m = LogisticRegression(C=8, max_iter=3000).fit(mk(tr), y[tr])
        _fill(tf_proba, te, m, m.predict_proba(mk(te)), classes)
    tf_pred = classes[tf_proba.argmax(1)]

    make = lambda: LogisticRegression(C=C, class_weight=cw, max_iter=3000)
    p_value = _permutation_p(make, Xf, y, classes, f1, lambda yt, pr: f1_score(yt, classes[pr.argmax(1)], average="macro"))

    safe = np.clip(proba, 1e-6, 1)
    safe = safe / safe.sum(axis=1, keepdims=True)
    model = make().fit(Xf, y)
    return model, {
        "task": name, "n": int(len(y)), "classes": classes.tolist(), "support": {str(c): int((y == c).sum()) for c in classes},
        "chosen": {"C": C, "class_weight": cw}, "uses_creation_features": extra is not None, "evaluation": "validation croisée imbriquée + test de permutation",
        "cv": {"accuracy": round(float(accuracy_score(y, pred)), 4), "macro_f1": round(f1, 4), "log_loss": round(float(log_loss(y, safe, labels=classes)), 4),
               "permutation_p_value": round(float(p_value), 4), "confusion_matrix": confusion_matrix(y, pred, labels=classes).tolist()},
        "baselines": {
            "majority": {"accuracy": round(float((y == maj).mean()), 4), "macro_f1": round(float(f1_score(y, np.full_like(y, maj), average="macro")), 4)},
            "tfidf_logreg": {"accuracy": round(float(accuracy_score(y, tf_pred)), 4), "macro_f1": round(float(f1_score(y, tf_pred, average="macro")), 4)},
        },
    }


# ---------------------------------------------------------------------------------------------- régression par quantiles
def _features_ct(dim: int, n_tab: int, n_samples: int) -> ColumnTransformer:
    comps = int(max(2, min(24, n_samples - 2, dim)))
    return ColumnTransformer([("emb", PCA(n_components=comps, random_state=SEED), list(range(dim))), ("tab", StandardScaler(), list(range(dim, dim + n_tab)))])


def _pinball_rows(y: np.ndarray, Q: np.ndarray) -> np.ndarray:
    """Perte pinball moyenne sur les quantiles, une valeur par exemple."""
    a = np.array(QUANTILES)[None, :]
    d = y[:, None] - Q
    return np.maximum(a * d, (a - 1) * d).mean(axis=1)


def train_resolution(emb: np.ndarray, tab: np.ndarray, hours: np.ndarray, priority: np.ndarray) -> tuple[dict | None, dict]:
    ok = np.isfinite(hours) & (hours > 0)
    if ok.sum() < 30:
        return None, {"task": "resolution_time", "skipped": "pas assez de demandes résolues"}
    X = np.hstack([emb, tab])[ok]
    y = np.log1p(hours[ok])
    pr = priority[ok]
    dim, n_tab = emb.shape[1], tab.shape[1]

    def fit_all(Xtr, ytr):
        ct = _features_ct(dim, n_tab, len(ytr)).fit(Xtr)
        Z = ct.transform(Xtr)
        ms = {q: GradientBoostingRegressor(loss="quantile", alpha=q, n_estimators=120, max_depth=2, learning_rate=0.06, subsample=0.8, min_samples_leaf=4, random_state=SEED).fit(Z, ytr) for q in QUANTILES}
        return ct, ms

    oof = np.zeros((len(y), len(QUANTILES)))
    base_glob = np.zeros_like(oof)
    base_prio = np.zeros_like(oof)
    for tr, te in KFold(n_splits=5, shuffle=True, random_state=SEED).split(X):
        ct, ms = fit_all(X[tr], y[tr])
        oof[te] = np.sort(np.column_stack([ms[q].predict(ct.transform(X[te])) for q in QUANTILES]), axis=1)
        base_glob[te] = np.quantile(y[tr], QUANTILES)
        for idx in te:
            same = tr[pr[tr] == pr[idx]]
            base_prio[idx] = np.quantile(y[same] if len(same) >= 5 else y[tr], QUANTILES)

    H, O, G, P = np.expm1(y), np.expm1(oof), np.expm1(base_glob), np.expm1(base_prio)
    lm, lg, lp = _pinball_rows(H, O), _pinball_rows(H, G), _pinball_rows(H, P)
    # intervalle de confiance bootstrap (95 %) du gain moyen sur la référence « par priorité » : doit exclure zéro
    rng = np.random.default_rng(SEED)
    gains = np.array([np.mean((lp - lm)[rng.integers(0, len(lm), len(lm))]) for _ in range(1000)])
    lo, hi = np.percentile(gains, [2.5, 97.5])
    cover = lambda Q: float(np.mean((H >= Q[:, 0]) & (H <= Q[:, 4])))  # intervalle [q10, q90] : couverture visée 80 %
    ct, ms = fit_all(X, y)
    return {"ct": ct, "models": ms}, {
        "task": "resolution_time", "n": int(len(y)), "quantiles": QUANTILES,
        "cv": {"pinball_loss_hours": round(float(lm.mean()), 3), "mae_median_hours": round(float(np.mean(np.abs(H - O[:, 2]))), 3), "coverage_80": round(cover(O), 3)},
        "baselines": {"global_quantiles": {"pinball_loss_hours": round(float(lg.mean()), 3), "mae_median_hours": round(float(np.mean(np.abs(H - G[:, 2]))), 3), "coverage_80": round(cover(G), 3)},
                      "per_priority_quantiles": {"pinball_loss_hours": round(float(lp.mean()), 3), "mae_median_hours": round(float(np.mean(np.abs(H - P[:, 2]))), 3), "coverage_80": round(cover(P), 3)}},
        "skill_vs_per_priority": round(float(1 - lm.mean() / lp.mean()), 3), "gain_ci95_hours": [round(float(lo), 3), round(float(hi), 3)],
    }


# ---------------------------------------------------------------------------------------------- risque de réouverture
def train_reopen(emb: np.ndarray, tab: np.ndarray, reopened: np.ndarray, resolved: np.ndarray) -> tuple[Pipeline | None, dict]:
    X = np.hstack([emb, tab])[resolved]
    y = reopened[resolved].astype(int)
    if y.sum() < 6 or (1 - y).sum() < 6:
        return None, {"task": "reopen_risk", "skipped": "trop peu de réouvertures pour apprendre"}
    dim, n_tab = emb.shape[1], tab.shape[1]
    make = lambda: Pipeline([("ct", _features_ct(dim, n_tab, int(len(y) * 0.8))), ("lr", LogisticRegression(C=1.0, class_weight="balanced", max_iter=3000))])

    def oof_scores(yv: np.ndarray) -> np.ndarray:
        out = np.zeros(len(yv))
        for tr, te in StratifiedKFold(n_splits=int(min(5, yv.sum())), shuffle=True, random_state=SEED).split(X, yv):
            out[te] = make().fit(X[tr], yv[tr]).predict_proba(X[te])[:, 1]
        return out

    oof = oof_scores(y)
    pr_auc = float(average_precision_score(y, oof))
    rng = np.random.default_rng(SEED)
    hits = sum(average_precision_score(yp, oof_scores(yp)) >= pr_auc for yp in (rng.permutation(y) for _ in range(N_PERMUTATIONS)) if yp.sum() >= 2)
    p_value = (1 + hits) / (N_PERMUTATIONS + 1)
    prevalence = float(y.mean())
    return make().fit(X, y), {
        "task": "reopen_risk", "n": int(len(y)), "positives": int(y.sum()), "prevalence": round(prevalence, 4),
        "cv": {"roc_auc": round(float(roc_auc_score(y, oof)), 4), "pr_auc": round(pr_auc, 4), "permutation_p_value": round(float(p_value), 4)},
        "baselines": {"prevalence_pr_auc": round(prevalence, 4), "random_roc_auc": 0.5},
    }


# ---------------------------------------------------------------------------------------------- recherche (évaluation)
def evaluate_retrieval(export: dict, embedder: Embedder) -> dict:
    """Doublons et articles : le plongement multilingue contre TF-IDF. Vérité terrain = demandes liées au MÊME article
    de la base de connaissances par des agents (relation « used »), donc même problème, souvent formulé dans une autre langue."""
    import pandas as pd

    df = pd.DataFrame(export["tickets"])
    texts = [f"{t}. {b}"[:700] for t, b in zip(df["title"], df["body"])]
    ids = df["id"].tolist()
    idset = set(ids)
    lang = dict(zip(df["id"], df["lang"]))
    links = [l for l in export.get("links", []) if l.get("relation") == "used"]
    by_art: dict[str, list[str]] = {}
    for l in links:
        by_art.setdefault(l["article_id"], []).append(l["ticket_id"])
    groups = {a: [t for t in ts if t in idset] for a, ts in by_art.items()}
    groups = {a: ts for a, ts in groups.items() if len(ts) >= 2}
    if not groups:
        return {"skipped": "aucune paire de demandes reliées au même article"}

    E = embedder.encode(texts)
    S_sem = E @ E.T
    tf = TfidfVectorizer(preprocessor=_strip, ngram_range=(1, 2), sublinear_tf=True).fit(texts)
    M = tf.transform(texts)
    S_tf = (M @ M.T).toarray()
    pos = {i: k for k, i in enumerate(ids)}

    def run(S: np.ndarray, only_cross: bool) -> dict:
        hits, rr, n = [], [], 0
        for ts in groups.values():
            for t in ts:
                i = pos[t]
                rel = {pos[o] for o in ts if o != t and (not only_cross or lang[o] != lang[t])}
                if not rel:
                    continue
                order = [j for j in np.argsort(-S[i]) if j != i]
                hits.append(bool(rel & set(order[:5])))
                rr.append(1 / next((r + 1 for r, j in enumerate(order) if j in rel), len(order)))
                n += 1
        return {"queries": n, "hit_at_5": round(float(np.mean(hits)), 4) if n else None, "mrr": round(float(np.mean(rr)), 4) if n else None}

    kb = export.get("kb", [])
    kb_ids = [a["id"] for a in kb]
    art = {}
    if kb:
        kt = [f"{a['title']}. {a['body']}"[:900] for a in kb]
        Ssem = E @ embedder.encode(kt).T
        Stf = (M @ tf.transform(kt).T).toarray()
        for name, S in (("semantic", Ssem), ("tfidf", Stf)):
            h1 = h3 = n = 0
            for l in links:
                if l["ticket_id"] not in pos or l["article_id"] not in kb_ids:
                    continue
                order = np.argsort(-S[pos[l["ticket_id"]]])
                a = kb_ids.index(l["article_id"])
                n += 1
                h1 += int(order[0] == a)
                h3 += int(a in order[:3])
            art[name] = {"queries": n, "hit_at_1": round(h1 / n, 4) if n else None, "hit_at_3": round(h3 / n, 4) if n else None}

    return {
        "ground_truth": "demandes liées au même article par les agents",
        "duplicates_all": {"semantic": run(S_sem, False), "tfidf": run(S_tf, False)},
        "duplicates_cross_lingual": {"semantic": run(S_sem, True), "tfidf": run(S_tf, True)},
        "article_lookup": art,
    }


# ---------------------------------------------------------------------------------------------- barrière de qualité
# Un modèle n'est SERVI que s'il passe tous les contrôles. Sinon le service répond « non disponible » pour la tâche et le
# backend retombe sur son algorithme lexical : on ne sert jamais un modèle qui ne vaut pas mieux qu'une règle simple.
GATES = {"priority_macro_f1_margin": 0.03, "component_macro_f1_margin": 0.03, "max_p_value": 0.05, "resolution_coverage_tolerance": 0.15, "reopen_pr_auc_margin": 0.03}


def apply_gates(tasks: dict) -> dict:
    g: dict[str, dict] = {}
    v = lambda passed, reason: {"passed": bool(passed), "reason": reason}

    for name in ("priority", "component"):
        t = tasks[name]
        if t.get("skipped"):
            g[name] = v(False, t["skipped"]); continue
        best_base = max(t["baselines"]["majority"]["macro_f1"], t["baselines"]["tfidf_logreg"]["macro_f1"])
        m, p = t["cv"]["macro_f1"], t["cv"]["permutation_p_value"]
        margin = GATES[f"{name}_macro_f1_margin"]
        g[name] = v(m >= best_base + margin and p <= GATES["max_p_value"],
                    f"macro-F1 {m} contre {best_base} pour la meilleure référence (marge {margin}) ; p-valeur de permutation {p} (seuil {GATES['max_p_value']})")
    t = tasks["resolution_time"]
    if t.get("skipped"):
        g["resolution_time"] = v(False, t["skipped"])
    else:
        lo = t["gain_ci95_hours"][0]
        cov = t["cv"]["coverage_80"]
        g["resolution_time"] = v(lo > 0 and abs(cov - 0.8) <= GATES["resolution_coverage_tolerance"],
                                 f"gain {t['skill_vs_per_priority']} sur les quantiles par priorité, IC95 % du gain [{t['gain_ci95_hours'][0]}, {t['gain_ci95_hours'][1]}] h (doit exclure 0) ; couverture 80 % mesurée {cov}")
    t = tasks["reopen_risk"]
    if t.get("skipped"):
        g["reopen_risk"] = v(False, t["skipped"])
    else:
        c = t["cv"]
        g["reopen_risk"] = v(c["pr_auc"] >= t["baselines"]["prevalence_pr_auc"] + GATES["reopen_pr_auc_margin"] and c["permutation_p_value"] <= GATES["max_p_value"] and c["roc_auc"] > 0.6,
                             f"PR-AUC {c['pr_auc']} contre {t['baselines']['prevalence_pr_auc']} (prévalence) ; ROC-AUC {c['roc_auc']} ; p-valeur de permutation {c['permutation_p_value']}")
    return g


# ---------------------------------------------------------------------------------------------- orchestration
def train_all(export: dict, out_dir: str | Path = MODELS_DIR, embedder: Embedder | None = None, log=print) -> dict:
    t0 = time.time()
    df = tickets_frame(export)
    if len(df) < 40:
        raise ValueError(f"{len(df)} demandes : il en faut au moins 40 pour entraîner quelque chose de fiable.")
    embedder = embedder or make_embedder()
    log(f"Plongement de {len(df)} demandes avec {embedder.model_name} …")
    emb = embedder.encode(df["text"].tolist())
    tab = tabular_features(df)
    create = creation_features(df)
    texts = df["text"].tolist()

    log("Priorité …")
    prio_model, prio_card = train_classifier("priority", emb, df["priority"].to_numpy(), texts, extra=create)
    log("Composant …")
    has_comp = (df["component"] != "").to_numpy()
    comp_model, comp_card = train_classifier("component", emb[has_comp], df["component"].to_numpy()[has_comp], [t for t, h in zip(texts, has_comp) if h])
    log("Délai de résolution (quantiles) …")
    hours = df["resolution_hours"].to_numpy(dtype=float)
    res_bundle, res_card = train_resolution(emb, tab, hours, df["priority"].to_numpy())
    log("Risque de réouverture …")
    reo_model, reo_card = train_reopen(emb, tab, df["reopened"].to_numpy(), np.isfinite(hours))
    log("Recherche multilingue (évaluation) …")
    retrieval = evaluate_retrieval(export, embedder)

    tasks = {"priority": prio_card, "component": comp_card, "resolution_time": res_card, "reopen_risk": reo_card}
    index = {"emb": emb.astype(np.float32), "meta": [{"id": r.id, "key": r.key, "title": r.title, "priority": r.priority, "component": r.component or None,
                                                       "resolution_hours": None if not np.isfinite(r.resolution_hours) else round(float(r.resolution_hours), 1), "lang": r.lang}
                                                      for r in df.itertuples()]}
    card = {
        "name": "kairos-brain", "version": __version__, "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "embedding_model": embedder.model_name, "embedding_dim": embedder.dim, "n_train": int(len(df)), "data_fingerprint": fingerprint(df),
        "languages": sorted(df["lang"].dropna().unique().tolist()), "pii": "texte masqué avant export",
        "environment": {"python": platform.python_version(), "scikit_learn": sklearn.__version__, "numpy": np.__version__},
        "tasks": tasks, "gates": apply_gates(tasks), "retrieval": retrieval, "training_seconds": round(time.time() - t0, 1),
        "caveats": ["Métriques en validation croisée imbriquée sur vos propres demandes : la taille du jeu les rend bruitées.",
                    "Ré-entraînez régulièrement ; une tâche qui ne franchit pas la barrière de qualité n'est pas servie."],
    }
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    joblib.dump({"priority": prio_model, "component": comp_model, "resolution": res_bundle, "reopen": reo_model, "index": index,
                 "priorities": PRIORITIES, "card": card}, out / BUNDLE_NAME, compress=3)
    (out / CARD_NAME).write_text(json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"Modèles enregistrés dans {out} en {card['training_seconds']} s")
    return card
