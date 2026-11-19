# Kairos

Le copilote de support qui agit **au bon moment** (*kairos*), dans Jira Service Management et Confluence.
Il prévient avant qu'un SLA ne casse, repère l'incident qui naît, retrouve la réponse déjà écrite, dit quand il ne sait pas,
et fonctionne en français, anglais et espagnol. Aucune donnée n'est envoyée à un LLM payant.

```
Jira / Confluence ── Forge (agent Rovo, déclencheurs, panneau) ──▶ Backend Kairos ──▶ PostgreSQL
                                                                         │  ▲
                              Frontend React (fr · en · es) ◀────────────┘  │ export masqué / prédictions
                                                                         ▼  │
                                                           Kairos Brain (service d'IA, déployé à part)
```

| Dossier | Contenu |
|---|---|
| `backend/` | API Fastify 5 + PostgreSQL 16 : authentification complète, 48 analyses d'intelligence sans LLM, webhooks, audit infalsifiable |
| `frontend/` | Application React + Tailwind : landing, tableau de bord, demandes, copilote, intelligence, réglages |
| `forge-app/` | Application Forge : agent Rovo (6 actions), déclencheurs Jira, panneau de demande |
| `ml/` | **Kairos Brain** : notebook d'entraînement, modèles, service d'inférence FastAPI |

## Démarrer

```bash
cp .env.example .env            # renseigner JWT_SECRET et ENCRYPTION_KEY : openssl rand -hex 32
SEED_DEMO=true docker compose up --build
# application : http://localhost:8080   (compte de démonstration : voir backend/src/db/seed.js)
```

Développement local : `cd backend && npm run dev` (port 4000) et `cd frontend && npm run dev` (port 5173, proxifie `/api`).
En développement, le code de confirmation d'e-mail s'affiche dans la console du backend ; en production, définir `SMTP_URL`.

## Ce que fait le backend

* **Authentification** : inscription avec code e-mail à 6 chiffres (aucune session avant confirmation), 2FA TOTP et codes de secours,
  rotation des refresh tokens avec détection de vol, verrouillage de compte, Google et GitHub (OAuth + PKCE), clés d'API à portée.
* **48 analyses sans LLM** (`/api/v1/intel/*`) : prévision de SLA, incident naissant, réponse sourcée avec abstention, churn,
  radar de surcharge, prévision de capacité, risque de déploiement, segmentation de clients, résumé extractif, etc.
  Les réponses sont structurées (codes et nombres) : l'interface les affiche dans la langue de l'utilisateur.
* **Sécurité** : journal d'audit chaîné par hachage, protection SSRF des webhooks, signatures anti-rejeu, masquage des données
  personnelles avec coffre réversible, isolation stricte entre organisations (vérifiée par tests).

## Kairos Brain (le modèle d'IA)

Un plongement multilingue pré-entraîné plus des modèles légers appris sur **vos** demandes : priorité, composant, délai de
résolution (quantiles), risque de réouverture, et recherche sémantique entre langues. Voir [`ml/README.md`](ml/README.md).

* Évaluation rigoureuse : validation croisée imbriquée, références simples, test de permutation.
* **Barrière de qualité** : un modèle qui ne bat pas sa référence n'est pas servi ; le backend retombe sur ses algorithmes lexicaux.
* Déployé séparément ; le backend l'appelle avec un disjoncteur (`ML_URL`, `ML_API_KEY`). Sans lui, rien ne casse.
* Suivi réel : `GET /ml/monitoring` compare chaque prédiction servie à la décision finale des agents.

## Internationalisation

Français, anglais, espagnol. `npm run i18n:check` (lancé avant chaque build) échoue si une langue contient du texte d'une autre :
parité des clés et des variables, aucun texte en dur dans le JSX, énumérations et codes d'erreur du backend tous traduits.
Le contenu saisi par les utilisateurs (titres de demandes, articles) n'est évidemment pas traduit.

## Application Forge

```bash
cd forge-app
npm i -g @forge/cli && forge login
forge register                      # remplace l'identifiant dans manifest.yml
# manifest.yml : remotes.baseUrl et permissions.external.fetch.backend.address = URL publique HTTPS du backend
forge lint && forge deploy && forge install
```
Le manifeste passe le validateur officiel hors ligne (`forge-app/.validate.cjs`) ; `forge lint` complet exige une connexion Atlassian.

## Tests

| Commande | Portée |
|---|---|
| `cd backend && npm test` | 103 tests d’intégration sur une vraie base PostgreSQL (auth, sécurité, 48 analyses, OAuth contre de faux fournisseurs, pont vers le service d’IA) |
| `cd ml && KAIROS_EMBEDDER=hash python -m unittest discover -s tests` | 23 tests : entraînement, barrière de qualité, service, rechargement à chaud |
| `cd frontend && npm run i18n:check` | cohérence des trois langues |

## Limites connues, dites franchement

* Les données de démonstration sont fabriquées (155 demandes) : les métriques du modèle d'IA qui en sortent ne prouvent rien.
  Entraînez sur vos vraies demandes (notebook `ml/notebooks/kairos_brain_training.ipynb`).
* L'API Teamwork Graph d'Atlassian est en accès anticipé : elle n'est pas intégrée.
* L'application mobile Flutter n'est pas commencée.
