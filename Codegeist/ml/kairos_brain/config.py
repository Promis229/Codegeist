from __future__ import annotations

import os
from pathlib import Path

# Plongement multilingue (≈118 M de paramètres, 384 dimensions, 50+ langues dont fr/en/es).
EMBED_MODEL = os.environ.get("KAIROS_EMBED_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
MODELS_DIR = Path(os.environ.get("KAIROS_MODELS_DIR", Path(__file__).resolve().parents[1] / "models"))
BUNDLE_NAME = "kairos_brain.joblib"
CARD_NAME = "model_card.json"

PRIORITIES = ["low", "medium", "high", "critical"]
TIERS = ["standard", "premium", "enterprise"]
CHANNELS = ["portal", "email", "api", "chat"]
QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9, 0.95]
SEED = 7

MAX_TEXT_CHARS = 700          # texte envoyé au plongement (titre + début du corps)
MAX_CANDIDATES = 1000         # candidats acceptés par requête de recherche
CACHE_SIZE = 20000            # plongements gardés en mémoire (par empreinte de texte)
