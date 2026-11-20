import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';
import { env } from '../config/env.js';
import { one } from '../db/pool.js';
import { slugify } from './service.js';
import { unauthorized } from '../lib/errors.js';

// Cles publiques de signature des Forge Invocation Tokens (FIT). Voir la doc "Forge remote - essentials".
const JWKS_URL = process.env.FORGE_JWKS_URL ?? 'https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json';
let jwks;
let override = null;

/** Permet aux tests d'injecter un verificateur sans appeler le reseau. */
export const setForgeVerifier = (fn) => { override = fn; };

/**
 * Audiences acceptees pour notre application. Le jeton porte l'ARI complet (ari:cloud:ecosystem::app/<uuid>) ;
 * on accepte aussi l'UUID nu, au cas ou la variable FORGE_APP_ID ne contient que l'identifiant.
 */
export function forgeAudiences(appId) {
  const id = String(appId ?? '').trim();
  if (!id) return [];
  const uuid = id.split('/').pop();
  return [...new Set([id, uuid, `ari:cloud:ecosystem::app/${uuid}`])];
}

export function looksLikeForgeToken(token) {
  try { return decodeProtectedHeader(token).alg === 'RS256'; } catch { return false; }
}

export async function verifyForgeToken(token) {
  if (override) return override(token);
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30_000 });
  try {
    const opts = { issuer: 'forge/invocation-token', algorithms: ['RS256'] };
    if (env.forgeAppId) opts.audience = forgeAudiences(env.forgeAppId); // l'audience DOIT etre notre application
    else if (env.isProd) throw new Error('FORGE_APP_ID requis en production');
    const { payload } = await jwtVerify(token, jwks, opts);
    return payload;
  } catch (e) {
    // Motif du rejet dans les journaux (jamais le jeton lui-meme) : aide a diagnostiquer une mauvaise configuration.
    console.warn('[forge] jeton refuse :', e?.code ?? e?.name, e?.claim ?? '', e?.message);
    throw unauthorized('Forge Invocation Token invalide');
  }
}

/** Retrouve (ou provisionne) l'organisation liee a un site Atlassian (cloudId). */
export async function orgForCloud(cloudId) {
  if (!cloudId) throw unauthorized('cloudId absent du jeton Forge');
  const found = await one('SELECT id FROM orgs WHERE forge_cloud_id=$1', [cloudId]);
  if (found) return found.id;
  const created = await one(
    `INSERT INTO orgs(name, slug, forge_cloud_id, settings) VALUES ($1,$2,$3,'{"portalEnabled":false}')
     ON CONFLICT (forge_cloud_id) DO UPDATE SET forge_cloud_id = EXCLUDED.forge_cloud_id RETURNING id`,
    [`Atlassian ${cloudId.slice(0, 8)}`, `${slugify('atl')}-${cloudId.slice(0, 8)}`, cloudId],
  );
  return created.id;
}
