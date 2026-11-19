"""Génère kairos_brain_training.ipynb (stdlib uniquement). Lancer : python3 notebooks/build_notebook.py"""
import json
from pathlib import Path

cells = []
md = lambda s: cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(True)})
code = lambda s: cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(True)})

md("""
# Kairos Brain : entraîner le modèle sur vos vraies demandes

Ce notebook entraîne les modèles d'IA de Kairos à partir des demandes de **votre** service desk (synchronisées depuis
Jira Service Management dans le backend Kairos), les **évalue sans complaisance**, puis les prépare pour le déploiement
dans un service séparé que le backend appelle directement.

**Ce qu'on entraîne**

| Modèle | Rôle | Utilisé par |
|---|---|---|
| Plongement multilingue (pré-entraîné, gelé) | comprendre le sens en français, anglais, espagnol | recherche de doublons et d'articles, tous les modèles ci-dessous |
| Priorité et composant | triage à la création d'une demande | agent Rovo, panneau Jira |
| Délai de résolution (quantiles) | « il restera ~X h, 90 % des cas sous Y h » et probabilité de dépasser le SLA | prévision SLA |
| Risque de réouverture | repérer les demandes à clore avec soin | file de travail |

**Principes**
1. *Vos données restent chez vous* : le texte est masqué (e-mails, téléphones, IBAN…) par le backend **avant** l'export.
2. *Pas de modèle sans preuve* : chaque modèle est comparé à des références simples sur des données qu'il n'a jamais vues
   (validation croisée). **Un modèle qui ne les bat pas n'est pas servi** (barrière de qualité) ; le backend utilise alors
   son algorithme lexical.
3. *Explicable* : chaque prédiction renvoie les cas passés les plus proches comme preuve.
""")

md("## 1. Configuration")
code("""
%pip install -q -r ../requirements.txt
""")
code("""
import os, sys, json, getpass
from pathlib import Path
sys.path.insert(0, str(Path('..').resolve()))          # rend le package kairos_brain importable

# Origine des données : l'API Kairos (clé d'API de portée « admin ») OU un export JSON déjà téléchargé.
BACKEND_URL = os.environ.get('KAIROS_API_URL', 'http://localhost:4000')
EXPORT_FILE = os.environ.get('KAIROS_EXPORT_FILE', '')   # ex. 'export.json' pour travailler hors ligne
API_KEY = os.environ.get('KAIROS_API_KEY') or ('' if EXPORT_FILE else getpass.getpass('Clé d\\'API Kairos (admin) : '))
MODELS_OUT = Path('../models')
""")

md("## 2. Récupérer les données depuis le backend\nL'export est réservé aux administrateurs, journalisé dans l'audit et déjà masqué.")
code("""
from kairos_brain import data

export = data.load_export(EXPORT_FILE) if EXPORT_FILE else data.fetch_export(BACKEND_URL, API_KEY)
df = data.tickets_frame(export)
print(f"{len(df)} demandes, {len(export['kb'])} articles, {len(export['links'])} liens demande-article")
df[['key', 'lang', 'component', 'priority', 'tier', 'resolution_hours', 'reopened']].head()
""")

md("## 3. Auditer les données avant de modéliser\nLa qualité d'un modèle est plafonnée par celle de ses données : on regarde d'abord ce qu'on a.")
code("""
import matplotlib.pyplot as plt

fig, ax = plt.subplots(1, 4, figsize=(16, 3.2))
df['priority'].value_counts().reindex(['low', 'medium', 'high', 'critical']).plot.bar(ax=ax[0], title='Priorité', color='#e08a3c')
df['component'].replace('', '(vide)').value_counts().plot.bar(ax=ax[1], title='Composant', color='#c96a2b')
df['lang'].value_counts().plot.bar(ax=ax[2], title='Langue', color='#a85a22')
df['resolution_hours'].dropna().clip(upper=df['resolution_hours'].quantile(.98)).plot.hist(ax=ax[3], bins=25, title='Heures de résolution', color='#8a4a1e')
plt.tight_layout(); plt.show()

resolved = df['resolution_hours'].notna()
print(f"Résolues : {resolved.sum()} · Rouvertes : {int(df.loc[resolved, 'reopened'].sum())} ({df.loc[resolved, 'reopened'].mean():.1%} des résolues)")
if len(df) < 300:
    print('\\nATTENTION : moins de 300 demandes. Les métriques ci-dessous seront bruitées ; reprenez ce notebook quand')
    print('le volume aura grossi. La barrière de qualité empêche de toute façon de servir un modèle qui ne prouve rien.')
""")

md("""
## 4. Le socle : un plongement multilingue
Un modèle pré-entraîné transforme chaque texte en un vecteur de 384 nombres où des phrases de **même sens sont proches,
quelle que soit la langue**. C'est ce qui permet de reconnaître qu'« Erreur 502 lors du paiement » et
« Payment fails at checkout with error 502 » décrivent le même incident.
""")
code("""
from kairos_brain.embedder import make_embedder
import numpy as np

embedder = make_embedder()
emb = embedder.encode(df['text'].tolist())
print(embedder.model_name, emb.shape)

from sklearn.decomposition import PCA
xy = PCA(2, random_state=7).fit_transform(emb)
fig, ax = plt.subplots(1, 2, figsize=(13, 4.4))
for a, col, title in ((ax[0], 'component', 'Colorié par composant'), (ax[1], 'lang', 'Colorié par langue')):
    for v, g in df.groupby(df[col].replace('', '(vide)')):
        a.scatter(xy[g.index, 0], xy[g.index, 1], s=14, label=v, alpha=.8)
    a.set_title(title); a.legend(fontsize=7)
plt.tight_layout(); plt.show()
""")
md("Si le plongement est bon, les points se regroupent par **composant** (le sens) et se mélangent entre **langues** : un même sujet occupe la même zone en français et en anglais.")

md("""
## 5. Entraîner et évaluer
`train_all` entraîne les quatre modèles puis calcule **en validation croisée** (chaque exemple est prédit par un modèle qui
ne l'a jamais vu) les métriques et celles de références simples, puis applique la barrière de qualité.
""")
code("""
from kairos_brain import train

card = train.train_all(export, MODELS_OUT, embedder=embedder)
import pandas as pd
pd.DataFrame([{'tâche': k, 'servi': g['passed'], 'détail': g['reason']} for k, g in card['gates'].items()])
""")

md("### 5.1 Priorité et composant\nComparaison à la classe majoritaire et à un TF-IDF + régression logistique (la solution lexicale classique).")
code("""
fig, ax = plt.subplots(1, 2, figsize=(12, 3.6))
for a, name in zip(ax, ('priority', 'component')):
    t = card['tasks'][name]
    if t.get('skipped'): a.set_title(f"{name} : ignoré ({t['skipped']})"); continue
    vals = {'majoritaire': t['baselines']['majority']['macro_f1'], 'TF-IDF': t['baselines']['tfidf_logreg']['macro_f1'], 'Kairos Brain': t['cv']['macro_f1']}
    a.bar(vals.keys(), vals.values(), color=['#999', '#bbb', '#e08a3c']); a.set_ylim(0, 1); a.set_title(f'{name} : macro-F1 (validation croisée)')
    for i, v in enumerate(vals.values()): a.text(i, v + .02, f'{v:.2f}', ha='center')
plt.tight_layout(); plt.show()

t = card['tasks']['priority']
if not t.get('skipped'):
    cm = np.array(t['cv']['confusion_matrix']); labels = t['classes']
    plt.figure(figsize=(4.4, 3.8)); plt.imshow(cm, cmap='Oranges')
    plt.xticks(range(len(labels)), labels, rotation=45); plt.yticks(range(len(labels)), labels)
    for i in range(len(labels)):
        for j in range(len(labels)): plt.text(j, i, cm[i, j], ha='center', va='center')
    plt.title('Priorité : matrice de confusion'); plt.xlabel('prédit'); plt.ylabel('réel'); plt.show()
""")

md("""
### 5.2 Délai de résolution
Le modèle prédit des **quantiles** (pas une moyenne) : « médiane 6 h, 90 % des cas sous 31 h ». Deux contrôles :
la perte *pinball* (plus bas = mieux) face aux quantiles par priorité, et la **couverture** : l'intervalle P10–P90
doit contenir ~80 % des durées réelles, sinon les intervalles mentent.
""")
code("""
t = card['tasks']['resolution_time']
if t.get('skipped'): print('Ignoré :', t['skipped'])
else:
    rows = [('Kairos Brain', t['cv']), ('par priorité', t['baselines']['per_priority_quantiles']), ('global', t['baselines']['global_quantiles'])]
    print(pd.DataFrame([{'modèle': n, **m} for n, m in rows]).to_string(index=False))
    print(f"\\nGain sur la référence par priorité : {t['skill_vs_per_priority']:+.1%}  (couverture visée : 80 %)")
""")

md("### 5.3 Risque de réouverture\nClasse rare : on regarde la PR-AUC (face à la prévalence) plutôt que l'exactitude.")
code("""
t = card['tasks']['reopen_risk']
print('Ignoré :', t['skipped']) if t.get('skipped') else print(json.dumps({k: t[k] for k in ('n', 'positives', 'prevalence', 'cv', 'baselines')}, indent=2))
""")

md("""
### 5.4 Recherche multilingue : le vrai différenciateur
Vérité terrain : des demandes que les agents ont **reliées au même article** de la base (donc même problème), souvent
écrites dans deux langues. On mesure si, pour une demande, une autre demande du même problème apparaît dans les 5
premiers résultats : le plongement contre TF-IDF, et surtout **entre langues différentes**, là où la recherche lexicale ne
voit rien.
""")
code("""
r = card['retrieval']
if 'skipped' in r: print('Ignoré :', r['skipped'])
else:
    rows = []
    for k, label in (('duplicates_all', 'toutes langues'), ('duplicates_cross_lingual', 'langues différentes')):
        for m in ('tfidf', 'semantic'):
            rows.append({'cas': label, 'méthode': m, **r[k][m]})
    print(pd.DataFrame(rows).to_string(index=False))
    print('\\nRetrouver l\\'article utilisé à partir de la demande :', json.dumps(r['article_lookup']))
""")

md("## 6. Expliquer une prédiction\nChaque réponse du service joint les cas passés les plus proches : on peut vérifier le raisonnement.")
code("""
import joblib
bundle = joblib.load(MODELS_OUT / 'kairos_brain.joblib')
i = int(df[df['resolution_hours'].notna()].index[0])
sims = bundle['index']['emb'] @ bundle['index']['emb'][i]
pd.DataFrame([bundle['index']['meta'][j] for j in np.argsort(-sims)[1:6]]).assign(similarité=np.sort(sims)[::-1][1:6].round(3))[['key', 'title', 'priority', 'component', 'resolution_hours', 'similarité']]
""")

md("""
## 7. Déployer à part et brancher au backend

Le modèle est servi par un **service séparé** (image Docker `ml/Dockerfile`), que le backend appelle en HTTP.

```bash
# 1) le service (monte le dossier models/ produit ci-dessus)
docker build -t kairos-brain ./ml
docker run -p 8100:8100 -e KAIROS_ML_API_KEY=<secret partagé> -v $(pwd)/ml/models:/app/models kairos-brain

# 2) le backend : deux variables d'environnement suffisent
ML_URL=http://kairos-brain:8100  ML_API_KEY=<secret partagé>
```

Sans ces variables, ou si le service tombe, **rien ne casse** : le backend retombe sur ses algorithmes lexicaux
(disjoncteur intégré). Après un ré-entraînement : `POST /v1/reload` recharge le modèle **sans redémarrage**.
""")

md("## 8. Test de bout en bout du service (en mémoire)")
code("""
os.environ['KAIROS_MODELS_DIR'] = str(MODELS_OUT.resolve())
from fastapi.testclient import TestClient
from kairos_brain import service

with TestClient(service.app) as c:
    print('santé    :', c.get('/health').json())
    q = 'Erreur 502 lors du paiement, impossible de finaliser la commande'
    cands = [{'id': str(i), 'text': t, 'lang': l} for i, (t, l) in enumerate(zip(df['text'], df['lang']))][:200]
    print('recherche:', c.post('/v1/search', json={'query': q, 'candidates': cands, 'top_k': 3}).json())
    print('triage   :', c.post('/v1/predict/triage', json={'title': q, 'body': ''}).json())
    print('risque   :', c.post('/v1/predict/risk', json={'title': q, 'body': '', 'priority': 'high', 'sla_hours': 12}).json())
""")

md("""
## 9. Après le déploiement : surveiller et ré-entraîner

- **Suivi réel** : le backend journalise chaque prédiction servie puis la compare à la décision finale des agents
  (`GET /ml/monitoring` : justesse mesurée, calibration par niveau de confiance, alerte « ré-entraîner »).
- **Ré-entraînement** : relancer ce notebook, ou `python -m kairos_brain train --api … --key …` en tâche planifiée
  hebdomadaire, puis `POST /v1/reload`. La fiche du modèle (`models/model_card.json`) garde l'empreinte des données, les
  versions et toutes les métriques : à conserver à chaque version.
- **Limites à connaître** : les métriques dépendent de la taille du jeu (voir l'audit §3) ; les mesures de risque sont
  observationnelles ; ne jamais fonder une décision irréversible sur une prédiction seule.
""")

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 5}
out = Path(__file__).with_name("kairos_brain_training.ipynb")
out.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{out} : {len(cells)} cellules")
