# Deploying Kairos

Two supported setups:

* **A. Vercel + Neon + Modal** (serverless, free tiers): the frontend and the API are two separate Vercel projects.
* **B. Docker** on a single server (1 vCPU and 1 GB of RAM are enough) with a domain name.

No hosted embedding model or paid AI API is needed: the `ml/` service is optional (see "The AI model is optional").

---

## A. Vercel (frontend and backend as separate projects)

| Service | Folder | Role |
|---|---|---|
| Vercel project `kairos-web` | `frontend/` | React PWA. Its `vercel.json` rewrites `/api/*` to the API project (same origin for the browser: no CORS, no cross-site cookies) |
| Vercel project `kairos-api` | `backend/` | Fastify API as a serverless function (`api/index.js`). Migrations and the demo data set are applied at every build (`scripts/vercel-build.mjs`) |
| Neon (Vercel integration) | – | PostgreSQL 16 |
| Modal | `ml/modal_app.py` | Kairos Brain (AI service), free Starter plan, scales to zero |

### 1. Create the projects

In each Vercel project set **Settings → General → Root Directory** to `backend` or `frontend`, and connect the GitHub
repository: every push to `main` then deploys both projects. (If you deploy with the CLI instead, run `vercel deploy --prod`
from the repository root after linking the project there; with a Root Directory set, running it from inside the folder doubles
the path.)

```bash
vercel integration add neon --name kairos-db        # accept the terms in the browser; adds DATABASE_URL to the API project
```

### 2. Environment variables of `kairos-api`

| Variable | Value |
|---|---|
| `JWT_SECRET`, `ENCRYPTION_KEY` | `openssl rand -hex 32` each. Back up `ENCRYPTION_KEY`: without it, 2FA secrets and the personal-data vault are unreadable |
| `CRON_SECRET` | `openssl rand -hex 24` (protects the scheduled webhook retry job) |
| `PUBLIC_URL`, `WEB_URL` | `https://<frontend domain>` (both) |
| `TRUST_PROXY`, `PG_POOL_MAX` | `true`, `3` |
| `SMTP_URL`, `MAIL_FROM` | outgoing mail for confirmation codes, e.g. `smtp://user:pass@smtp.gmail.com:587?requireTLS=true` |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | optional social sign-in (see below) |
| `SEED_DEMO`, `DEMO_LOGIN` | `true`, `true` **only** for a showcase deployment (see "Demo") |
| `ML_URL`, `ML_API_KEY` | AI service (see "The AI model is optional") |
| `FORGE_APP_ID` | **Required in production** for the Forge app: the app id from the Forge manifest, in the form `ari:cloud:ecosystem::app/<uuid>`. Without it the backend rejects every Forge Invocation Token (the Jira panel then shows "Remote could not verify the Forge Invocation Token"). Redeploy after adding it. |

In `frontend/vercel.json`, the `/api/:path*` rewrite must point to the API project's host.

### 3. Things to know

* **Google / GitHub sign-in**: add `https://<frontend domain>/api/v1/auth/oauth/<google|github>/callback` to the authorized
  redirect URIs of each provider (GitHub accepts a single callback URL per OAuth App).
* **Attachments**: 3 MB per message in total (Vercel limits request bodies to 4.5 MB, base64 included).
* **Outgoing webhooks**: sent right after each write (`waitUntil`) and retried once a day by the scheduled job `/internal/cron`.
* **Demo data**: if the demo organization predates the multilingual content, the build recreates it (it never touches any other organization).

---

## B. Docker on your own server

### 1. Get the code and configure

```bash
git clone <your-repository> kairos && cd kairos
cp .env.example .env
openssl rand -hex 32     # paste into JWT_SECRET
openssl rand -hex 32     # paste into ENCRYPTION_KEY
openssl rand -hex 24     # paste into POSTGRES_PASSWORD
```

Also set in `.env`:

| Variable | Value |
|---|---|
| `PUBLIC_URL` and `WEB_URL` | `https://your-domain` |
| `SMTP_URL` | mail server for confirmation codes, e.g. `smtps://user:pass@smtp.example.com:465` |
| `MAIL_FROM` | sender, e.g. `Kairos <no-reply@your-domain>` |
| `SEED_DEMO` / `DEMO_LOGIN` | `true` / `true` **only** for a showcase deployment (see "Demo") |

> Without `SMTP_URL` nobody can sign up: the 6-digit code is not sent (and, on purpose, never written to the production logs).
> For a presentation without e-mail, use the demo entry.

### 2. Start with automatic HTTPS

```bash
DOMAIN=your-domain WEB_BIND=127.0.0.1 \
  docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

Prerequisites: the DNS record of `your-domain` points to the server, ports 80 and 443 are open.
Check: `https://your-domain` shows the landing page and `https://your-domain/api/v1/auth/providers` answers with JSON.

### 3. Operations

| Need | Command |
|---|---|
| Update | `git pull && docker compose ... up -d --build` (migrations run at startup) |
| Back up | `docker compose exec db pg_dump -U kairos kairos > backup.sql` |
| Restore | `docker compose exec -T db psql -U kairos kairos < backup.sql` |
| Logs | `docker compose logs -f backend` |
| Health | `GET /health` (process) and `GET /ready` (database) |

---

## Google and GitHub sign-in

Create the two providers once; keep their credentials in the environment (`GOOGLE_CLIENT_ID/SECRET`,
`GITHUB_CLIENT_ID/SECRET`), never in Git. Then add the production return address:

| Where | What |
|---|---|
| Google Cloud → your project → Google Auth Platform → **Clients** → web client | Authorized redirect URI: `https://your-domain/api/v1/auth/oauth/google/callback` |
| GitHub → Settings → Developer settings → OAuth Apps → your app | Callback URL: `https://your-domain/api/v1/auth/oauth/github/callback`, Homepage URL: `https://your-domain` |
| Environment | `PUBLIC_URL=https://your-domain` and `WEB_URL=https://your-domain` (the return to the application must match exactly) |

**Google in production**: while the app is in "Testing" mode only the listed test users can sign in. To open it to everyone
(judges included), fill in **Branding** (home page, privacy policy, terms, authorized domain = your domain), then
**Audience → Publish app**. The requested scopes (`openid`, `email`, `profile`) do not need Google verification.

## Demo (judges, video, trial)

With `SEED_DEMO=true` and `DEMO_LOGIN=true` the landing page offers **"Try the demo"**: an **agent** session on the demo
organization, without a password. It is **never an administrator** (no export, no API keys, no audit log, no member
management) and cannot see any other organization (verified by tests). Reserve it for a showcase deployment: do not enable it on
an instance that holds real data. The demo content (team messages, channel topics, automation rule names) is stored in French,
English and Spanish and shown in the language of the interface.

## Connecting the Forge app

1. In Kairos: **Settings → API keys**, create a key with the "Read and write" scope (it is shown only once).
2. In `forge-app/`:

```bash
npm install
npx forge login
npx forge register                                    # writes the app id into manifest.yml
node scripts/configure.mjs https://your-api-host      # sets the backend URL and the allowed egress address
npx forge variables set KAIROS_URL https://your-api-host
npx forge variables set --encrypt KAIROS_API_KEY kai_xxxxxxxx
npx forge lint && npx forge deploy && npx forge install
```

The "Kairos Support Copilot" agent then appears in Rovo, and the "Kairos Copilot" panel in the issue view.
Cross-language search goes through the agent: its LLM (hosted by Atlassian) translates the question and the backend merges
the results. Nothing more to host.

## The AI model is optional

Kairos works completely without it (48 statistical and lexical analyses). The `ml/` service adds a model trained on your
requests (see `ml/README.md`) plus cross-language semantic search for the copilot.

* **Docker**: `docker compose --profile ml up`, then `ML_URL` and `ML_API_KEY` in `.env`.
* **Modal** (free, no card; PyTorch is too large for a Vercel function):

  ```bash
  pip install modal && modal setup
  modal secret create kairos-ml KAIROS_ML_API_KEY=<secret> KAIROS_ENV=production
  modal deploy ml/modal_app.py
  ```

  Put the printed URL in `ML_URL` and the same key in `ML_API_KEY` of `kairos-api`, then redeploy. The service shuts down
  without traffic: the first call after a pause takes about 10 to 30 seconds. The API wakes it up when a session opens and when
  the copilot page is opened, and waits for it when answering; in the meantime it falls back to its lexical algorithms.
* Tasks whose model does not pass the quality gate (priority, component) are deliberately refused by the service (503): the
  backend then uses its lexical algorithm.
