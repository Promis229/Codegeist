"""Exécute toutes les cellules de code du notebook dans l'ordre (sans Jupyter), pour prouver qu'il tourne de bout en bout.
Usage : cd notebooks && KAIROS_EMBEDDER=hash KAIROS_EXPORT_FILE=../data/demo-export.json MPLBACKEND=Agg python run_notebook_check.py
"""
import json
import sys
import traceback
from pathlib import Path

nb = json.loads(Path(__file__).with_name("kairos_brain_training.ipynb").read_text(encoding="utf-8"))
ns: dict = {"__name__": "__main__"}
failed = 0
for i, cell in enumerate(nb["cells"]):
    if cell["cell_type"] != "code":
        continue
    src = "".join(cell["source"])
    if src.lstrip().startswith("%pip"):
        print(f"[{i}] (ignoré) {src.strip()}")
        continue
    try:
        exec(compile(src, f"cellule-{i}", "exec"), ns)
        print(f"[{i}] ok")
    except Exception:
        failed += 1
        print(f"[{i}] ÉCHEC")
        traceback.print_exc()
print("TOUTES LES CELLULES S'EXÉCUTENT" if not failed else f"{failed} cellule(s) en échec")
sys.exit(1 if failed else 0)
