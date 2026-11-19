"""Télécharge (une fois) le modèle de plongement multilingue et vérifie qu'il comprend le sens entre langues.
Usage : python scripts/fetch_model.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np

from kairos_brain.config import EMBED_MODEL
from kairos_brain.embedder import Embedder

t0 = time.time()
print(f"Téléchargement et chargement de {EMBED_MODEL} …")
emb = Embedder()
print(f"prêt en {time.time() - t0:.0f} s · dimension {emb.dim}")

# Contrôle de bon sens : une même phrase en 3 langues doit être très proche, une phrase sans rapport très éloignée.
phrases = [
    "Erreur 502 lors du paiement",
    "Payment fails at checkout with error 502",
    "El pago falla en la caja con error 502",
    "Comment exporter mes factures en CSV ?",
]
v = emb.encode(phrases)
sim = v @ v.T
print("similarité fr/en :", round(float(sim[0, 1]), 3), "| fr/es :", round(float(sim[0, 2]), 3), "| fr/sans rapport :", round(float(sim[0, 3]), 3))
assert sim[0, 1] > 0.6 and sim[0, 2] > 0.6 and sim[0, 3] < 0.4, "le modèle ne relie pas les langues comme attendu"
print("OK : même sens = proche, quelle que soit la langue.")
