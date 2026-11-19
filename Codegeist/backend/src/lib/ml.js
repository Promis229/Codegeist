import { env } from '../config/env.js';
import { redactPII } from './text.js';

/**
 * Client du service d'IA « Kairos Brain » (deploye separement, voir /ml).
 *  - jamais bloquant : delai court, disjoncteur apres 3 echecs consecutifs (30 s), l'appelant retombe sur l'algorithme lexical
 *  - jamais de donnee personnelle : tout texte est masque (PII) avant de quitter ce processus
 *  - authentifie par cle partagee (ML_API_KEY)
 */
const FAILS_TO_OPEN = 3;
const OPEN_MS = 30_000;
let fails = 0, openUntil = 0;

export const mlConfigured = () => !!env.mlUrl;
export const mlOpen = () => Date.now() < openUntil;
export const resetMlBreaker = () => { fails = 0; openUntil = 0; };
export const scrub = (s) => redactPII(String(s ?? '')).text;

/** Appelle le service. Renvoie `null` (et non une exception) si indisponible : c'est le contrat de repli. */
export async function mlCall(path, body, { timeoutMs = 4000, method = body === undefined ? 'GET' : 'POST' } = {}) {
  if (!env.mlUrl || mlOpen()) return null;
  try {
    const res = await fetch(`${env.mlUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(env.mlApiKey ? { authorization: `Bearer ${env.mlApiKey}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`ml ${res.status}`);
    fails = 0;
    return await res.json();
  } catch {
    if (++fails >= FAILS_TO_OPEN) openUntil = Date.now() + OPEN_MS;
    return null;
  }
}
