"""Ligne de commande : python -m kairos_brain <train|serve|card> …"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .config import MODELS_DIR


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kairos_brain", description="Entraîner et servir les modèles Kairos Brain")
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("train", help="entraîner à partir de l'API Kairos ou d'un export JSON")
    t.add_argument("--api", default=os.environ.get("KAIROS_API_URL"), help="URL du backend (ex. http://localhost:4000)")
    t.add_argument("--key", default=os.environ.get("KAIROS_API_KEY"), help="clé d'API de portée admin")
    t.add_argument("--file", help="export JSON déjà téléchargé")
    t.add_argument("--out", default=str(MODELS_DIR))
    t.add_argument("--limit", type=int, default=5000)

    s = sub.add_parser("serve", help="lancer le service d'inférence")
    s.add_argument("--host", default="0.0.0.0")
    s.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8100")))

    c = sub.add_parser("card", help="afficher la fiche du modèle entraîné")
    c.add_argument("--dir", default=str(MODELS_DIR))

    a = ap.parse_args(argv)
    if a.cmd == "train":
        from . import data, train

        if a.file:
            export = data.load_export(a.file)
        elif a.api and a.key:
            export = data.fetch_export(a.api, a.key, a.limit)
        else:
            ap.error("fournir --file, ou --api et --key")
        card = train.train_all(export, a.out)
        for name, g in card["gates"].items():
            print(f"  {'OK ' if g['passed'] else 'NON'} {name}: {g['reason']}")
        return 0
    if a.cmd == "serve":
        import uvicorn

        uvicorn.run("kairos_brain.service:app", host=a.host, port=a.port, log_level="info")
        return 0
    if a.cmd == "card":
        from pathlib import Path

        print(Path(a.dir, "model_card.json").read_text(encoding="utf-8"))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
