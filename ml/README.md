# Kairos Brain

Les modèles d'IA de Kairos : entraînés sur **vos** demandes, servis à part, branchés directement au backend.

## Ce qui est entraîné

| Modèle | Entrée → sortie | Contrôle avant de le servir |
|---|---|---|
| Plongement multilingue (`paraphrase-multilingual-MiniLM-L12-v2`, pré-entraîné, gelé) | texte → vecteur de 384 nombres, même sens = proches, quelle que soit la langue | recherche entre langues évaluée contre TF-IDF |
| Priorité | texte + offre du client + canal → priorité probable | macro-F1 > meilleure référence + marge, p-valeur de permutation ≤ 0,05 |
| Composant | texte → composant probable | idem |
| Délai de résolution | texte + contexte → quantiles P10…P95, probabilité de dépasser le SLA | perte *pinball* meilleure que « quantiles par priorité », IC95 % du gain excluant 0, couverture 80 % honnête |
| Risque de réouverture | texte + contexte → probabilité | PR-AUC > prévalence + marge, p-valeur de permutation ≤ 0,05 |

Chaque prédiction renvoie les cas passés les plus proches comme **preuve**.

## Pourquoi des « références » et une « barrière de qualité »

Un modèle ne vaut que s'il fait mieux que ce qu'on obtiendrait sans lui. L'évaluation compare donc chaque modèle à la classe
majoritaire, à TF-IDF + régression logistique et aux quantiles par priorité, en **validation croisée imbriquée** (les
hyperparamètres ne voient jamais le pli de test) et avec un **test de permutation** (le modèle doit battre ses propres
étiquettes mélangées). Si une tâche échoue, le service répond 503 pour elle et le backend retombe sur son algorithme lexical :
on ne sert jamais un modèle qui ne vaut pas mieux qu'une règle simple. La fiche `models/model_card.json` garde les métriques,
l'empreinte des données et les versions.

## Entraîner

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu     # CPU : pas de GPU requis
pip install -r requirements.txt

# a) depuis l'API Kairos (clé d'API de portée « admin » ; le texte est masqué côté backend)
python -m kairos_brain train --api http://localhost:4000 --key kai_xxxxx --out models
# b) ou depuis un export déjà téléchargé
python -m kairos_brain train --file data/export.json --out models
```

Le notebook `notebooks/kairos_brain_training.ipynb` fait la même chose avec l'audit des données, les graphiques, l'explication
d'une prédiction et un test du service. Il se régénère avec `python notebooks/build_notebook.py` et se vérifie sans Jupyter avec
`python notebooks/run_notebook_check.py`.

## Déployer à part et brancher

```bash
docker build -t kairos-brain ./ml          # télécharge le modèle de plongement une fois, au build
docker run -p 8100:8100 -e KAIROS_ML_API_KEY=<secret> -v $(pwd)/ml/models:/app/models kairos-brain
# ou : docker compose --profile ml up --build

# backend :
ML_URL=http://kairos-brain:8100   ML_API_KEY=<secret>
```

Après un ré-entraînement : `POST /v1/reload` recharge le modèle sans redémarrage.

| Route du service | Rôle |
|---|---|
| `GET /health` | sonde de santé (publique) |
| `GET /v1/model` | fiche du modèle : version, métriques, barrières |
| `POST /v1/search` | recherche sémantique multilingue |
| `POST /v1/predict/triage` | priorité et composant, avec preuves |
| `POST /v1/predict/risk` | délai (quantiles), réouverture, dépassement de SLA |
| `POST /v1/reload` | recharge le modèle depuis le disque |

Routes du backend qui s'appuient dessus (avec repli automatique) : `GET /ml/export`, `GET /ml/status`, `GET /ml/monitoring`,
`POST /intel/semantic/search`, `GET /intel/tickets/:id/semantic-similar`, `GET /intel/tickets/:id/risk`, `POST /intel/triage/priority`.

## Vie privée

Le backend masque les données personnelles (e-mails, téléphones, IBAN…) **avant** d'exporter pour l'entraînement et avant chaque
appel au service. L'export est réservé aux administrateurs et journalisé. Le service tourne chez vous.

## Limites

* Les métriques dépendent de la taille du jeu : en dessous de quelques centaines de demandes elles sont bruitées.
* Les mesures de risque sont observationnelles ; ne jamais fonder une décision irréversible sur une prédiction seule.
* `KAIROS_EMBEDDER=hash` (plongement de test) n'existe que pour les tests automatiques : il ne comprend pas le sens.
