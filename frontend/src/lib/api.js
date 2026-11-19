// Client API : jeton d'acces en memoire, refresh token en localStorage, rotation automatique sur 401.
export const BASE = import.meta.env.VITE_API_URL || '/api/v1';
const RT = 'kairos.refresh';

let access = null;
let inflightRefresh = null;
const listeners = new Set();

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error;
    this.details = body?.details;
    this.issues = body?.issues;
  }
}

const read = () => { try { return localStorage.getItem(RT); } catch { return null; } };
const write = (v) => { try { v ? localStorage.setItem(RT, v) : localStorage.removeItem(RT); } catch { /* stockage indisponible */ } };

export const tokens = {
  set({ accessToken, refreshToken }) { access = accessToken; if (refreshToken) write(refreshToken); },
  clear() { access = null; write(null); listeners.forEach((f) => f()); },
  hasRefresh: () => !!read(),
  onLogout(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

async function send(path, { method = 'GET', body, auth = true, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && access) headers.Authorization = `Bearer ${access}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { res, data };
}

async function refresh() {
  const rt = read();
  if (!rt) throw new ApiError(401, { error: 'session_expired' });
  inflightRefresh ??= send('/auth/refresh', { method: 'POST', body: { refreshToken: rt }, auth: false })
    .then(({ res, data }) => {
      if (!res.ok) throw new ApiError(res.status, data);
      tokens.set(data);
    })
    .finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}

/** Le serveur a REFUSE le jeton (vol, expiration, déconnexion) : seul cas où l'on vide la session. Une coupure réseau, un 429 ou un 5xx la gardent. */
const authRefused = (e) => e instanceof ApiError && (e.status === 401 || e.status === 403);

export async function api(path, opts = {}) {
  let { res, data } = await send(path, opts);
  if (res.status === 401 && opts.auth !== false && read()) {
    try { await refresh(); ({ res, data } = await send(path, opts)); }
    catch (e) { if (authRefused(e)) { tokens.clear(); throw new ApiError(401, { error: 'session_expired' }); } throw e; }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Télécharge un fichier protégé (pièce jointe, photo) avec le jeton d'accès : une balise <img> ne peut pas envoyer d'en-tête. */
export async function getBlob(path) {
  const run = () => fetch(`${BASE}${path}`, { headers: access ? { Authorization: `Bearer ${access}` } : {} });
  let res = await run();
  if (res.status === 401 && read()) {
    try { await refresh(); res = await run(); } catch (e) { if (authRefused(e)) { tokens.clear(); } throw e; }
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res.blob();
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { method: 'POST', body: body ?? {}, ...o });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

/** Restaure la session au chargement a partir du refresh token. */
export async function restore() {
  if (!read()) return false;
  try { await refresh(); return true; } catch (e) { if (authRefused(e)) tokens.clear(); return false; }
}
