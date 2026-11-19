# Déployer Kairos

Il suffit d'**un serveur avec Docker** (1 vCPU, 1 Go de RAM suffisent) et d'**un nom de domaine**. Aucun modèle d'IA à héberger :
le service `ml/` est facultatif (voir plus bas).

## 1. Récupérer le code et configurer

```bash
git clone <votre-depôt> kairos && cd kairos
cp .env.example .env
openssl rand -hex 32     # à coller dans JWT_SECRET
openssl rand -hex 32     # à coller dans ENCRYPTION_KEY
openssl rand -hex 24     # à coller dans POSTGRES_PASSWORD
```

Dans `.env`, renseigner aussi :

| Variable | Valeur |
|---|---|
| `PUBLIC_URL` et `WEB_URL` | `https://votre-domaine` |
| `SMTP_URL` | serveur d'envoi des codes de confirmation, ex. `smtps://user:pass@smtp.example.com:465` |
| `MAIL_FROM` | expéditeur, ex. `Kairos <no-reply@votre-domaine>` |
| `SEED_DEMO` / `DEMO_LOGIN` | `true` / `true` **uniquement** pour un déploiement de présentation (voir « Démonstration ») |

> Sans `SMTP_URL`, personne ne peut s'inscrire : le code à 6 chiffres n'est pas envoyé (et il n'est volontairement jamais écrit
> dans les journaux en production). Pour une présentation sans e-mail, utiliser l'entrée démo.

## 2. Lancer avec HTTPS automatique

```bash
DOMAIN=votre-domaine WEB_BIND=127.0.0.1 \
  docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

Prérequis : l'enregistrement DNS de `votre-domaine` pointe vers le serveur, ports 80 et 443 ouverts.
Vérification : `https://votre-domaine` affiche la page d'accueil, `https://votre-domaine/api/v1/auth/providers` répond en JSON.

## 2 bis. Connexion Google et GitHub

Les deux fournisseurs sont déjà créés pour le développement local (projet Google Cloud « Kairos », application OAuth GitHub
« Kairos »), leurs identifiants sont dans `.env` (`GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, jamais dans Git).
Quand vous avez votre domaine, **ajoutez-y l'adresse de retour de production** :

| Où | Quoi |
|---|---|
| Google Cloud → projet *Kairos* → Google Auth Platform → **Clients** → « Kairos web » | URI de redirection autorisée : `https://votre-domaine/api/v1/auth/oauth/google/callback` |
| GitHub → Settings → Developer settings → OAuth Apps → *Kairos* | « Redirect URI » : `https://votre-domaine/api/v1/auth/oauth/github/callback`, et « Homepage URL » : `https://votre-domaine` |
| `.env` | `PUBLIC_URL=https://votre-domaine` et `WEB_URL=https://votre-domaine` (le retour vers l'application doit correspondre exactement) |

**Google en production** : tant que l'application est en mode « Test », seuls les utilisateurs de test listés (Google Auth Platform
→ Audience) peuvent se connecter. Pour ouvrir à tout le monde (jury compris), renseignez d'abord **Branding** (page d'accueil,
politique de confidentialité, conditions, domaine autorisé = votre domaine), puis **Audience → Publish app**. Les portées
demandées (`openid`, `email`, `profile`) ne nécessitent pas de vérification Google.

## 3. Démonstration (jury, vidéo, essai)

Avec `SEED_DEMO=true` et `DEMO_LOGIN=true`, la page d'accueil propose **« Essayer la démo »** : une session d'**agent** sur
l'organisation de démonstration, sans mot de passe. Elle n'est **jamais administrateur** (ni export, ni clés d'API, ni audit,
ni gestion des membres) et ne voit aucune autre organisation (vérifié par des tests). À réserver à un déploiement de
présentation : ne pas l'activer sur une instance qui contient de vraies données.

## 4. Brancher l'application Forge

1. Dans Kairos : **Réglages → Clés d'API**, créer une clé de portée « Lecture et écriture » (elle n'est montrée qu'une fois).
2. Dans `forge-app/` :

```bash
npm i -g @forge/cli && forge login
forge register                                        # écrit l'identifiant d'application dans manifest.yml
node scripts/configure.mjs https://votre-domaine      # renseigne l'URL du backend et l'adresse autorisée
forge variables set KAIROS_URL https://votre-domaine
forge variables set --encrypt KAIROS_API_KEY kai_xxxxxxxx
forge lint && forge deploy && forge install
```

L'agent « Kairos Support Copilot » apparaît alors dans Rovo, le panneau « Kairos Copilot » dans l'écran d'une demande.
La recherche entre langues passe par l'agent : c'est son LLM (hébergé par Atlassian) qui traduit la question, le backend
fusionne les résultats. Rien à héberger de plus.

## 5. Exploitation

| Besoin | Commande |
|---|---|
| Mettre à jour | `git pull && docker compose ... up -d --build` (les migrations s'appliquent au démarrage) |
| Sauvegarder | `docker compose exec db pg_dump -U kairos kairos > sauvegarde.sql` |
| Restaurer | `docker compose exec -T db psql -U kairos kairos < sauvegarde.sql` |
| Journaux | `docker compose logs -f backend` |
| Santé | `GET /health` (processus) et `GET /ready` (base de données) |

Sauvegardez aussi `ENCRYPTION_KEY` : sans elle, les secrets 2FA et le coffre de données personnelles sont illisibles.

## 6. Le modèle d'IA est facultatif

Kairos fonctionne complètement sans lui (48 analyses statistiques et lexicales). Si vous pouvez un jour héberger un petit
service Python, `ml/` ajoute un modèle entraîné sur vos demandes (voir `ml/README.md`) : `docker compose --profile ml up`,
puis `ML_URL` et `ML_API_KEY` dans `.env`. Le backend retombe automatiquement sur ses algorithmes si le service est absent.

## Déployer sur Vercel (frontend et backend séparés)

Deux projets Vercel indépendants, une base PostgreSQL Neon (intégration Vercel) :

| Projet | Dossier | Rôle |
|---|---|---|
| `kairos-web` | `frontend/` | application React (PWA) ; `vercel.json` relaie `/api/*` vers le backend (même origine : pas de CORS) |
| `kairos-api` | `backend/` | API Fastify en fonction serverless (`api/index.js`) ; migrations et jeu de démonstration appliqués à chaque build (`scripts/vercel-build.mjs`) |

```bash
cd backend  && vercel integration add neon --name kairos-db && vercel deploy --prod
# renseigner dans le projet kairos-api : JWT_SECRET, ENCRYPTION_KEY (openssl rand -hex 32), CRON_SECRET, SMTP_URL, MAIL_FROM,
# GOOGLE_*/GITHUB_* , TRUST_PROXY=true, PG_POOL_MAX=3, PUBLIC_URL=WEB_URL=https://<domaine du frontend>
cd frontend && sed -i 's/kairos-api-omega.vercel.app/<hôte-api>/' vercel.json && vercel deploy --prod
```

Points d'attention :
- **Connexion Google / GitHub** : ajouter `https://<domaine-frontend>/api/v1/auth/oauth/<google|github>/callback` aux URI de redirection autorisées de chaque fournisseur.
- **Pièces jointes** : 3 Mo au total par message (limite de 4,5 Mo des requêtes Vercel, base64 compris).
- **Webhooks sortants** : envoyés juste après chaque écriture (`waitUntil`), relancés chaque jour par la tâche planifiée `/internal/cron` (`CRON_SECRET`).
- **Service d'IA (`ml/`)** : PyTorch dépasse la taille d'une fonction Vercel. À héberger sur un service de conteneurs (Hugging Face Spaces Docker, Fly.io, Render…), puis définir `ML_URL` et `ML_API_KEY` (identique à `KAIROS_ML_API_KEY`) dans `kairos-api` et redéployer. Sans lui, les analyses lexicales prennent le relais.
