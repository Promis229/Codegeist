"""Tests de Kairos Brain : entraînement, barrière de qualité, service HTTP, rechargement à chaud.

Lancer :  KAIROS_EMBEDDER=hash python -m unittest discover -s tests -v
Les jeux de données ci-dessous sont des FIXTURES de test (générées), pas des données de démonstration : elles servent à
prouver que la barrière de qualité accepte un modèle qui apprend et refuse un modèle qui n'a rien appris.
"""
from __future__ import annotations

import os
import random
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["KAIROS_EMBEDDER"] = "hash"  # aucun téléchargement de modèle dans les tests
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from fastapi.testclient import TestClient

from kairos_brain import service, train
from kairos_brain.config import MAX_CANDIDATES, QUANTILES

COMPONENTS = {
    "checkout": ["Erreur 502 lors du paiement", "Payment fails with error 502", "El pago falla con error 502", "Checkout bloqué sur le spinner"],
    "api": ["Limite de débit 429 dépassée", "Rate limit 429 on bulk export", "Límite de tasa 429 en la API", "Webhook signature invalide"],
    "mobile": ["L'application mobile plante au démarrage", "Mobile app crashes on launch", "La aplicación se cierra al abrir", "Mise à jour mobile impossible"],
    "account": ["Mot de passe oublié lien expiré", "Cannot reset my password", "No puedo restablecer la contraseña", "Connexion SSO impossible"],
}
URGENT = ["Production arrêtée, tous les clients touchés.", "Production is down, all customers affected.", "Producción caída, todos los clientes afectados."]
CALM = ["Question simple, pas urgent.", "Minor question, no rush.", "Pregunta menor, sin prisa."]


def make_export(n: int = 240, learnable: bool = True, seed: int = 3) -> dict:
    rnd = random.Random(seed)
    tickets, links = [], []
    kb = [{"id": f"kb-{c}", "title": f"Guide {c}", "body": " ".join(v), "updated_at": None} for c, v in COMPONENTS.items()]
    for i in range(n):
        comp = rnd.choice(list(COMPONENTS))
        urgent = rnd.random() < 0.35
        title = rnd.choice(COMPONENTS[comp])
        body = rnd.choice(URGENT if urgent else CALM)
        prio = ("critical" if urgent else rnd.choice(["low", "medium"])) if learnable else rnd.choice(["low", "medium", "high", "critical"])
        frus = rnd.random()
        hours = max(0.2, rnd.lognormvariate({"checkout": 1.0, "api": 1.8, "mobile": 2.6, "account": 0.4}[comp] - (0.6 if urgent else 0), 0.35))
        resolved = rnd.random() < 0.85
        tickets.append({
            "id": f"t{i}", "key": f"T-{i}", "title": title, "body": body, "lang": rnd.choice(["fr", "en", "es"]), "component": comp, "priority": prio,
            "channel": "portal", "status": "resolved" if resolved else "open", "created_at": "2026-01-01T00:00:00Z", "frustration": frus, "sentiment": -frus,
            "reopened_count": 0, "reopened": resolved and frus > 0.75 and rnd.random() < 0.7, "tier": rnd.choice(["standard", "premium", "enterprise"]),
            "resolution_hours": hours if resolved else None, "first_response_minutes": 30, "customer_messages": 1,
        })
        if resolved:
            links.append({"ticket_id": f"t{i}", "article_id": f"kb-{comp}", "relation": "used"})
    return {"schema": 1, "tickets": tickets, "kb": kb, "links": links}


def train_accepting_lexical_ties(export: dict, out: Path):
    """Le plongement de TEST (n-grammes de caractères) ne comprend pas mieux le texte que TF-IDF : sur ce jeu, à signal
    purement lexical, les deux se valent. On désactive donc UNIQUEMENT la marge face à TF-IDF (jamais le test de
    permutation) pour vérifier le chemin « modèle accepté »."""
    saved = dict(train.GATES)
    train.GATES.update(priority_macro_f1_margin=-1.0, component_macro_f1_margin=-1.0)
    try:
        return train.train_all(export, out, log=lambda *_: None)
    finally:
        train.GATES.clear(); train.GATES.update(saved)


class GateLogic(unittest.TestCase):
    """La barrière est une fonction pure : on la teste directement, sans entraîner."""

    def tasks(self, **over):
        t = {
            "priority": {"baselines": {"majority": {"macro_f1": 0.2}, "tfidf_logreg": {"macro_f1": 0.5}}, "cv": {"macro_f1": 0.6, "permutation_p_value": 0.038}},
            "component": {"baselines": {"majority": {"macro_f1": 0.2}, "tfidf_logreg": {"macro_f1": 0.5}}, "cv": {"macro_f1": 0.6, "permutation_p_value": 0.038}},
            "resolution_time": {"skill_vs_per_priority": 0.2, "gain_ci95_hours": [0.1, 0.5], "cv": {"coverage_80": 0.78}},
            "reopen_risk": {"baselines": {"prevalence_pr_auc": 0.15}, "cv": {"pr_auc": 0.4, "roc_auc": 0.75, "permutation_p_value": 0.038}},
        }
        for k, v in over.items():
            t[k] = v
        return t

    def test_all_pass(self):
        self.assertTrue(all(g["passed"] for g in train.apply_gates(self.tasks()).values()))

    def test_refuses_when_not_better_than_the_best_baseline(self):
        t = self.tasks(); t["priority"]["cv"]["macro_f1"] = 0.52
        self.assertFalse(train.apply_gates(t)["priority"]["passed"])

    def test_refuses_when_not_significant_even_if_the_score_looks_good(self):
        t = self.tasks(); t["priority"]["cv"]["permutation_p_value"] = 0.2
        g = train.apply_gates(t)["priority"]
        self.assertFalse(g["passed"])
        self.assertIn("permutation", g["reason"])

    def test_resolution_requires_a_gain_whose_interval_excludes_zero_and_honest_coverage(self):
        t = self.tasks(); t["resolution_time"]["gain_ci95_hours"] = [-0.2, 0.4]
        self.assertFalse(train.apply_gates(t)["resolution_time"]["passed"])
        t = self.tasks(); t["resolution_time"]["cv"]["coverage_80"] = 0.5
        self.assertFalse(train.apply_gates(t)["resolution_time"]["passed"])

    def test_reopen_requires_significance(self):
        t = self.tasks(); t["reopen_risk"]["cv"]["permutation_p_value"] = 0.3
        self.assertFalse(train.apply_gates(t)["reopen_risk"]["passed"])

    def test_skipped_tasks_are_never_served(self):
        t = self.tasks(reopen_risk={"task": "reopen_risk", "skipped": "trop peu de réouvertures"})
        self.assertFalse(train.apply_gates(t)["reopen_risk"]["passed"])


class TrainingAndGates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.good = Path(cls.tmp.name) / "good"
        cls.bad = Path(cls.tmp.name) / "bad"
        cls.card = train_accepting_lexical_ties(make_export(240, True), cls.good)
        cls.card_bad = train.train_all(make_export(240, False), cls.bad, log=lambda *_: None)  # barrière par défaut, intacte

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_card_is_complete_and_honest(self):
        c = self.card
        self.assertEqual(set(c["tasks"]), {"priority", "component", "resolution_time", "reopen_risk"})
        self.assertEqual(set(c["gates"]), set(c["tasks"]))
        self.assertEqual(c["n_train"], 240)
        self.assertEqual(len(c["data_fingerprint"]), 16)
        self.assertIn("baselines", c["tasks"]["priority"])
        self.assertTrue((self.good / "kairos_brain.joblib").exists() and (self.good / "model_card.json").exists())

    def test_gate_accepts_a_model_that_learns(self):
        g = self.card["gates"]
        self.assertTrue(g["priority"]["passed"], g["priority"]["reason"])
        self.assertTrue(g["component"]["passed"], g["component"]["reason"])
        self.assertGreater(self.card["tasks"]["priority"]["cv"]["macro_f1"], self.card["tasks"]["priority"]["baselines"]["majority"]["macro_f1"] + 0.2)
        self.assertLessEqual(self.card["tasks"]["priority"]["cv"]["permutation_p_value"], 0.05)

    def test_gate_refuses_a_model_that_learned_nothing(self):
        """Étiquettes aléatoires : aucun modèle ne peut battre le hasard, donc la priorité ne doit PAS être servie."""
        g = self.card_bad["gates"]["priority"]
        self.assertFalse(g["passed"], g["reason"])

    def test_cv_is_out_of_sample(self):
        """Sur des étiquettes aléatoires la validation croisée ne doit pas flatter : exactitude proche du hasard (≈ 25 %)."""
        acc = self.card_bad["tasks"]["priority"]["cv"]["accuracy"]
        self.assertLess(acc, 0.42)

    def test_resolution_quantiles_are_calibrated_enough(self):
        t = self.card["tasks"]["resolution_time"]
        self.assertGreater(t["skill_vs_per_priority"], 0)
        self.assertTrue(0.6 <= t["cv"]["coverage_80"] <= 0.97, t["cv"])

    def test_retrieval_evaluation_present(self):
        r = self.card["retrieval"]
        self.assertIn("duplicates_all", r)
        self.assertGreater(r["duplicates_all"]["semantic"]["queries"], 50)

    def test_refuses_tiny_datasets(self):
        with self.assertRaises(ValueError):
            train.train_all(make_export(20), Path(self.tmp.name) / "tiny", log=lambda *_: None)


class Service(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.good = Path(cls.tmp.name) / "good"
        cls.bad = Path(cls.tmp.name) / "bad"
        train_accepting_lexical_ties(make_export(240, True), cls.good)
        train.train_all(make_export(240, False), cls.bad, log=lambda *_: None)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def client(self, models: Path, key: str = ""):
        os.environ["KAIROS_MODELS_DIR"] = str(models)
        if key:
            os.environ["KAIROS_ML_API_KEY"] = key
        else:
            os.environ.pop("KAIROS_ML_API_KEY", None)
        service.STATE.update({"embedder": None, "bundle": None, "loaded": False})
        return TestClient(service.app)

    def test_auth_is_enforced_with_constant_time_compare(self):
        with self.client(self.good, "secret") as c:
            self.assertEqual(c.get("/health").status_code, 200)  # sonde de santé publique
            self.assertEqual(c.get("/v1/model").status_code, 401)
            self.assertEqual(c.get("/v1/model", headers={"Authorization": "Bearer mauvaise"}).status_code, 401)
            self.assertEqual(c.get("/v1/model", headers={"Authorization": "Bearer secret"}).status_code, 200)

    def test_production_without_a_key_refuses_to_answer(self):
        os.environ["KAIROS_ENV"] = "production"
        try:
            with self.client(self.good) as c:  # aucune clé configurée
                r = c.get("/v1/model")
                self.assertEqual(r.status_code, 503)
                self.assertIn("KAIROS_ML_API_KEY", r.json()["detail"])
                self.assertEqual(c.get("/health").status_code, 200)  # la sonde de santé reste publique
        finally:
            os.environ.pop("KAIROS_ENV", None)

    def test_model_card_exposes_gates_and_metrics(self):
        with self.client(self.good) as c:
            m = c.get("/v1/model").json()
            self.assertTrue(m["gates"]["priority"]["passed"])
            self.assertIn("priority", m["metrics"])

    def test_search_ranks_the_identical_text_first(self):
        with self.client(self.good) as c:
            cands = [{"id": str(i), "text": t} for i, t in enumerate(["Mise à jour mobile impossible", "Erreur 502 lors du paiement", "Mot de passe oublié lien expiré"])]
            r = c.post("/v1/search", json={"query": "Erreur 502 lors du paiement", "candidates": cands, "top_k": 3}).json()
            self.assertEqual(r["results"][0]["id"], "1")
            self.assertGreater(r["results"][0]["score"], r["results"][1]["score"])

    def test_search_limits_candidates(self):
        with self.client(self.good) as c:
            cands = [{"id": str(i), "text": "x"} for i in range(MAX_CANDIDATES + 1)]
            self.assertEqual(c.post("/v1/search", json={"query": "x", "candidates": cands}).status_code, 422)

    def test_triage_returns_probabilities_and_evidence(self):
        with self.client(self.good) as c:
            r = c.post("/v1/predict/triage", json={"title": "Erreur 502 lors du paiement", "body": "Production arrêtée, tous les clients touchés."}).json()
            self.assertAlmostEqual(sum(r["priority"]["probabilities"].values()), 1.0, places=2)
            self.assertEqual(r["priority"]["label"], "critical")
            self.assertEqual(r["component"]["label"], "checkout")
            self.assertEqual(len(r["evidence"]), 3)

    def test_risk_quantiles_monotonic_and_sla_probability_decreases_with_slack(self):
        with self.client(self.good) as c:
            base = {"title": "L'application mobile plante au démarrage", "body": "Question simple, pas urgent.", "priority": "low"}
            r = c.post("/v1/predict/risk", json={**base, "sla_hours": 2}).json()
            q = r["resolution_hours"]
            self.assertTrue(q["p10"] <= q["p25"] <= q["p50"] <= q["p75"] <= q["p90"] <= q["p95"])
            tight = r["sla_breach_probability"]
            loose = c.post("/v1/predict/risk", json={**base, "sla_hours": 200}).json()["sla_breach_probability"]
            self.assertTrue(0 <= loose <= tight <= 1)
            self.assertGreater(tight, loose)

    def test_a_task_that_failed_its_gate_is_not_served(self):
        with self.client(self.bad) as c:
            r = c.post("/v1/predict/triage", json={"title": "Erreur 502", "body": ""})
            self.assertEqual(r.status_code, 503)
            self.assertIn("barrière de qualité", r.json()["detail"])

    def test_hot_reload_swaps_the_model_without_restart(self):
        with self.client(self.bad) as c:
            self.assertEqual(c.post("/v1/predict/triage", json={"title": "Erreur 502", "body": ""}).status_code, 503)
            os.environ["KAIROS_MODELS_DIR"] = str(self.good)  # un ré-entraînement vient de publier un meilleur modèle
            self.assertTrue(c.post("/v1/reload").json()["reloaded"])
            self.assertEqual(c.post("/v1/predict/triage", json={"title": "Erreur 502", "body": ""}).status_code, 200)

    def test_p_exceed_is_a_proper_survival_function(self):
        qs = np.array([1, 2, 4, 8, 16, 24], dtype=float)
        vals = [service._p_exceed(qs, h) for h in (0, 1, 4, 16, 24, 1000)]
        self.assertEqual(vals[0], 1.0)
        self.assertEqual(vals[-1], 0.0)
        self.assertEqual(vals, sorted(vals, reverse=True))
        self.assertAlmostEqual(service._p_exceed(qs, 4), 0.5, places=2)  # la médiane vaut 4 h
        self.assertEqual(len(QUANTILES), 6)


if __name__ == "__main__":
    unittest.main()
