import api, { fetch, route } from '@forge/api';

/**
 * Fonctions Forge : actions de l'agent Rovo, declencheurs d'evenements et synchronisation Confluence.
 * Elles parlent au backend Kairos avec une cle d'API a portee limitee (variable Forge chiffree) :
 *   forge variables set --encrypt KAIROS_API_KEY <cle kai_...>
 *   forge variables set KAIROS_URL https://votre-backend
 */

async function kairos(path, { method = 'GET', body } = {}) {
  const base = process.env.KAIROS_URL;
  const key = process.env.KAIROS_API_KEY;
  if (!base || !key) throw new Error('KAIROS_URL et KAIROS_API_KEY doivent etre configurees (forge variables set).');
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Kairos ${res.status} : ${json.message ?? text.slice(0, 200)}`);
  return json;
}

// ---------------------------------------------------------------- Actions Rovo
// Les entrees sont extraites par un LLM : elles peuvent etre fausses. On les valide avant usage.
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v, def, lo, hi) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };

export async function triageRequest(payload) {
  const summary = str(payload.summary, 300);
  if (summary.length < 3) return { error: 'Resume manquant.' };
  return kairos('/forge/triage', { method: 'POST', body: { summary, description: str(payload.description, 20000) } });
}

export async function answer(payload) {
  const question = str(payload.question, 2000);
  if (question.length < 5) return { error: 'Question trop courte.' };
  const r = await kairos('/intel/answer', { method: 'POST', body: { question } });
  // On renvoie tel quel : l'abstention (abstained) doit rester visible pour l'agent.
  return r;
}

/**
 * Recherche multilingue sans modele d'embedding a heberger : le LLM de l'agent Rovo (heberge par Atlassian) traduit la
 * question ; le backend cherche avec chaque version et fusionne les classements.
 */
export async function findSimilar(payload) {
  const query = str(payload.query, 1000);
  if (query.length < 3) return { error: 'Question trop courte.' };
  const variants = str(payload.translations, 3000).split('|').map((s) => s.trim()).filter((s) => s.length >= 3 && s !== query).slice(0, 4);
  return kairos('/intel/semantic/search', { method: 'POST', body: { query, variants, scope: 'all', limit: 8 } });
}

export async function customersAtRisk(payload) {
  const r = await kairos('/intel/customers-at-risk');
  return { customers: r.customers.slice(0, int(payload.limit, 5, 1, 20)) };
}

export async function incidents() {
  return kairos('/intel/incidents/emerging');
}

export async function handoff(payload) {
  return kairos(`/intel/handoff?hours=${int(payload.hours, 8, 1, 48)}`);
}

export async function guardReply(payload) {
  const draft = str(payload.draft, 10000);
  if (!draft) return { error: 'Brouillon manquant.' };
  return kairos('/intel/reply/guard', { method: 'POST', body: { body: draft } });
}

// ---------------------------------------------------------------- Evenements Jira
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(adfToText).join(node.type === 'doc' ? '\n' : '');
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}

const PRIORITY = { highest: 'critical', critical: 'critical', blocker: 'critical', high: 'high', medium: 'medium', low: 'low', lowest: 'low' };

async function loadIssue(key) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${key}?fields=summary,description,priority,reporter,labels,components`);
  if (!res.ok) throw new Error(`Jira ${res.status}`);
  return res.json();
}

export async function onIssueCreated(event) {
  const key = event.issue?.key;
  if (!key) return;
  const issue = await loadIssue(key);
  const f = issue.fields;
  await kairos('/forge/issues', {
    method: 'POST',
    body: {
      issueKey: key,
      summary: str(f.summary, 300) || key,
      description: adfToText(f.description).slice(0, 20000),
      priority: PRIORITY[(f.priority?.name ?? '').toLowerCase()],
      component: f.components?.[0]?.name?.slice(0, 60),
      reporterEmail: f.reporter?.emailAddress,
      reporterName: f.reporter?.displayName?.slice(0, 100),
      labels: (f.labels ?? []).slice(0, 20),
    },
  });
}

export async function onIssueCommented(event) {
  const key = event.issue?.key;
  const c = event.comment;
  if (!key || !c) return;
  const issue = await loadIssue(key);
  await kairos('/forge/comments', {
    method: 'POST',
    body: {
      issueKey: key,
      body: adfToText(c.body).slice(0, 10000) || '(vide)',
      fromCustomer: !!c.author?.accountId && c.author.accountId === issue.fields.reporter?.accountId,
      internal: c.jsdPublic === false,
    },
  });
}

// ---------------------------------------------------------------- Confluence -> base de connaissances
const htmlToText = (h) => String(h ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export async function syncKnowledge() {
  const res = await api.asApp().requestConfluence(route`/wiki/api/v2/pages?body-format=storage&limit=50&sort=-modified-date`);
  if (!res.ok) throw new Error(`Confluence ${res.status}`);
  const data = await res.json();
  const base = data._links?.base ?? '';
  const pages = (data.results ?? [])
    .map((p) => ({ id: String(p.id), title: str(p.title, 200), body: htmlToText(p.body?.storage?.value).slice(0, 100000), url: p._links?.webui ? `${base}${p._links.webui}` : undefined, space: String(p.spaceId ?? '') }))
    .filter((p) => p.title && p.body.length > 40);
  if (pages.length) await kairos('/forge/kb/sync', { method: 'POST', body: { pages } });
}
