# Kairos Brain

Kairos' AI models: trained on **your** requests, served separately, wired directly into the backend.

## What is trained

| Model | Input → output | Check before serving it |
|---|---|---|
| Multilingual embedding (`paraphrase-multilingual-MiniLM-L12-v2`, pre-trained, frozen) | text → 384-number vector; same meaning = close, whatever the language | cross-language search evaluated against TF-IDF |
| Priority | text + customer plan + channel → likely priority | macro-F1 > best baseline + margin, permutation p-value ≤ 0.05 |
| Component | text → likely component | same |
| Resolution time | text + context → quantiles P10…P95, probability of breaching the SLA | pinball loss better than "quantiles per priority", 95% CI of the gain excluding 0, honest 80% coverage |
| Reopening risk | text + context → probability | PR-AUC > prevalence + margin, permutation p-value ≤ 0.05 |

Every prediction returns the closest past cases as **evidence**.

## Why "baselines" and a "quality gate"

A model is only worth what it adds over what you would get without it. The evaluation therefore compares each model with the
majority class, TF-IDF + logistic regression and per-priority quantiles, using **nested cross-validation** (hyper-parameters never
see the test fold) and a **permutation test** (the model must beat its own shuffled labels). If a task fails, the service answers
503 for it and the backend falls back to its lexical algorithm: a model that is not better than a simple rule is never served.
The `models/model_card.json` file keeps the metrics, the data fingerprint and the versions.

## Train

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu     # CPU only: no GPU required
pip install -r requirements.txt

# a) from the Kairos API (API key with the "admin" scope; the text is masked on the backend side)
python -m kairos_brain train --api http://localhost:4000 --key kai_xxxxx --out models
# b) or from an export you already downloaded
python -m kairos_brain train --file data/export.json --out models
```

The notebook `notebooks/kairos_brain_training.ipynb` does the same with data auditing, charts, the explanation of one
prediction and a service test. It is regenerated with `python notebooks/build_notebook.py` and checked without Jupyter with
`python notebooks/run_notebook_check.py`.

## Deploy separately and connect

```bash
docker build -t kairos-brain ./ml          # downloads the embedding model once, at build time
docker run -p 8100:8100 -e KAIROS_ML_API_KEY=<secret> -v $(pwd)/ml/models:/app/models kairos-brain
# or: docker compose --profile ml up --build

# backend:
ML_URL=http://kairos-brain:8100   ML_API_KEY=<secret>
```

**Serverless alternative (Modal, free Starter plan, scales to zero):**

```bash
pip install modal && modal setup
modal secret create kairos-ml KAIROS_ML_API_KEY=<secret> KAIROS_ENV=production
modal deploy ml/modal_app.py            # prints https://<account>--kairos-brain-web.modal.run  → ML_URL
```

After retraining, `POST /v1/reload` reloads the model without a restart.

| Service route | Role |
|---|---|
| `GET /health` | health probe (public) |
| `GET /v1/model` | model card: version, metrics, quality gates |
| `POST /v1/search` | multilingual semantic search |
| `POST /v1/predict/triage` | priority and component, with evidence |
| `POST /v1/predict/risk` | resolution time (quantiles), reopening, SLA breach |
| `POST /v1/reload` | reloads the model from disk |

Backend routes that rely on it (with automatic fallback): `GET /ml/export`, `GET /ml/status`, `GET /ml/monitoring`,
`POST /ml/warm`, `POST /intel/semantic/search`, `GET /intel/tickets/:id/semantic-similar`, `GET /intel/tickets/:id/risk`,
`POST /intel/triage/priority`, and the copilot's sourced answer (`POST /intel/answer`).

## Privacy

The backend masks personal data (e-mails, phone numbers, IBANs…) **before** exporting for training and before every call to the
service. The export is reserved to administrators and logged. The service runs on infrastructure you control.

## Limits

* Metrics depend on the size of the data set: below a few hundred requests they are noisy.
* Risk estimates are observational; never base an irreversible decision on a single prediction.
* `KAIROS_EMBEDDER=hash` (test embedding) exists only for automated tests: it does not understand meaning.
