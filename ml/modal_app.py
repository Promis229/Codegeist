"""Déploiement de Kairos Brain sur Modal (serverless, offre gratuite : l'instance s'éteint sans trafic).

    pip install modal && modal setup                       # une fois : connexion au compte
    modal secret create kairos-ml KAIROS_ML_API_KEY=<secret> KAIROS_ENV=production
    modal deploy ml/modal_app.py                           # depuis la racine du dépôt (ou depuis ml/)

L'URL affichée (https://<compte>--kairos-brain-web.modal.run) est à mettre dans ML_URL côté backend, avec la même clé dans ML_API_KEY.
Le modèle de plongement est téléchargé UNE fois, à la construction de l'image ; le service tourne ensuite sans accès à un modèle hébergé.
"""
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch", index_url="https://download.pytorch.org/whl/cpu")  # CPU seulement : évite ~2,5 Go de bibliothèques CUDA
    .pip_install_from_requirements(str(HERE / "requirements.txt"))
    .env({"HF_HOME": "/opt/hf", "KAIROS_MODELS_DIR": "/app/models", "KAIROS_EMBED_MODEL": EMBED_MODEL, "PYTHONUNBUFFERED": "1"})
    .run_commands(f"python -c \"from sentence_transformers import SentenceTransformer as S; S('{EMBED_MODEL}')\"")
    .add_local_dir(str(HERE / "kairos_brain"), "/app/kairos_brain", copy=True, ignore=["__pycache__", "*.pyc"])
    .add_local_dir(str(HERE / "models"), "/app/models", copy=True)
)

app = modal.App("kairos-brain", image=image)


@app.function(
    secrets=[modal.Secret.from_name("kairos-ml")],  # KAIROS_ML_API_KEY, KAIROS_ENV=production : le service refuse de répondre sans clé
    cpu=2.0,
    memory=3072,
    timeout=120,
    scaledown_window=600,  # reste chaud 10 min après la dernière requête
    max_containers=2,
)
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def web():
    import sys

    sys.path.insert(0, "/app")
    from kairos_brain.service import app as service

    return service
