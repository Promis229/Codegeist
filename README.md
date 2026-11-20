# Kairos

The support copilot that acts **at the right moment** (*kairos*), inside Jira Service Management and Confluence.
It warns you before an SLA breaks, spots an incident as it forms, finds the answer that was already written, says so when it
does not know, and works in French, English and Spanish. No data is sent to a paid LLM.

```
Jira / Confluence ── Forge (Rovo agent, triggers, panel) ──▶ Kairos backend ──▶ PostgreSQL
                                                                   │  ▲
                              React frontend (fr · en · es) ◀──────┘  │ masked export / predictions
                                                                   ▼  │
                                                     Kairos Brain (AI service, deployed separately)
```

| Folder | Contents |
|---|---|
| `backend/` | Fastify 5 + PostgreSQL 16 API: full authentication, 48 LLM-free intelligence analyses, team chat, webhooks, tamper-evident audit log |
| `frontend/` | React + Tailwind installable PWA: landing page, dashboard, tickets, copilot, intelligence, team chat, customers, automation, settings |
| `forge-app/` | Forge app: Rovo agent (7 actions), **Atlassian MCP server** exposing the same 7 tools (`rovo:mcp`), Jira triggers, issue panel |
| `ml/` | **Kairos Brain**: training notebook, models, FastAPI inference service |

## Getting started

```bash
cp .env.example .env            # set JWT_SECRET and ENCRYPTION_KEY: openssl rand -hex 32
SEED_DEMO=true docker compose up --build
# application: http://localhost:8080   (demo account: see backend/src/db/seed.js)
```

Local development: `cd backend && npm run dev` (port 4000) and `cd frontend && npm run dev` (port 5173, proxies `/api`).
In development the e-mail confirmation code is printed in the backend console; in production, set `SMTP_URL`.

Production deployment (Vercel for the frontend and the API as two separate projects, Neon PostgreSQL, Modal for the AI
service) is described in [`DEPLOY.md`](DEPLOY.md).

## What the backend does

* **Authentication**: sign-up with a 6-digit e-mail code (no session before confirmation), TOTP 2FA and backup codes,
  refresh-token rotation with theft detection, account lockout, Google and GitHub (OAuth + PKCE), scoped API keys.
* **48 LLM-free analyses** (`/api/v1/intel/*`): SLA forecast, emerging incident, sourced answer with abstention, churn,
  overload radar, capacity forecast, deployment risk, customer segmentation, extractive summary, and more.
  Responses are structured (codes and numbers): the interface renders them in the user's language.
* **Team workspace**: channels and direct messages, quoted replies, attachments with strict upload checks (magic-byte
  sniffing, closed allow-list, no SVG/HTML/executables/macros, optional ClamAV scan), profile photos, unified search.
* **Security**: hash-chained audit log, SSRF protection for webhooks, anti-replay signatures, personal-data masking with a
  reversible vault, strict isolation between organizations (verified by tests).

## Kairos Brain (the AI model)

A pre-trained multilingual embedding plus lightweight models learned from **your** requests: priority, component,
resolution time (quantiles), reopening risk, and cross-language semantic search. See [`ml/README.md`](ml/README.md).

* Rigorous evaluation: nested cross-validation, simple baselines, permutation test.
* **Quality gate**: a model that does not beat its baseline is not served; the backend falls back to its lexical algorithms.
* Deployed separately; the backend calls it through a circuit breaker (`ML_URL`, `ML_API_KEY`). Without it, nothing breaks.
* Real monitoring: `GET /ml/monitoring` compares each served prediction with the agents' final decision.

## Internationalization

French, English, Spanish. `npm run i18n:check` (run before every build) fails if a language contains text from another one:
key and variable parity, no hard-coded text in JSX, every backend enum and error code translated.
Text typed by users (ticket titles, articles) is of course not translated; the bundled demo content (team messages, channel
topics, rule names) is stored in all three languages and shown in the language of the interface (`X-Lang` header).

## Forge app

```bash
cd forge-app
npm install
npx forge login
npx forge register                  # replaces the app id in manifest.yml
# manifest.yml: remotes.baseUrl and permissions.external.fetch.backend.address = public HTTPS URL of the backend
npx forge lint && npx forge deploy && npx forge install
```

Once installed, the same seven actions are available as MCP tools (Rovo Studio agents, and external clients such as Claude at
`https://mcp.atlassian.com/forge/<app-id>` once a site admin enables external access). Requires `@forge/cli` 13.3 or higher.

The manifest passes the official validator offline (`forge-app/.validate.cjs`); the full `forge lint` requires an Atlassian login.

## Tests

| Command | Scope |
|---|---|
| `cd backend && npm test` | 153 integration tests on a real PostgreSQL database (auth, security, the 48 analyses, search, chat and uploads, OAuth against fake providers, the bridge to the AI service, demo content in three languages) |
| `cd ml && KAIROS_EMBEDDER=hash python -m unittest discover -s tests` | 23 tests: training, quality gate, service, hot reload |
| `cd frontend && npm run i18n:check` | consistency of the three languages |
