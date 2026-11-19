import fp from 'fastify-plugin';
import { one, query } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccess } from './tokens.js';
import { looksLikeForgeToken, orgForCloud, verifyForgeToken } from './forge.js';

const ROLE_RANK = { viewer: 1, agent: 2, admin: 3, owner: 4 };

/**
 * Decore la requete avec `req.auth = { userId, orgId, role, via, scopes }`.
 * - Bearer <jwt>      : session utilisateur (le role est RE-LU en base : une revocation est immediate).
 * - Bearer kai_<cle>  : cle d'API (portees read / write / admin, plafonnees par le role du proprietaire).
 */
async function plugin(app) {
  app.decorateRequest('auth', null);

  app.decorate('authenticate', async (req) => {
    const header = req.headers.authorization ?? '';
    const m = header.match(/^Bearer\s+(\S+)$/i);
    if (!m) throw unauthorized();
    const token = m[1];

    if (token.startsWith('kai_')) {
      const row = await one(
        `SELECT k.id, k.org_id, k.user_id, k.scopes, m.role, u.disabled
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
           JOIN memberships m ON m.user_id = k.user_id AND m.org_id = k.org_id
          WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
        [sha256(token)],
      );
      if (!row || row.disabled) throw unauthorized('Cle d\'API invalide');
      query('UPDATE api_keys SET last_used_at = now() WHERE id=$1', [row.id]).catch(() => {});
      req.auth = { userId: row.user_id, orgId: row.org_id, role: row.role, via: 'apikey', scopes: row.scopes, keyId: row.id };
      return;
    }

    // Appel provenant de l'application Forge (jeton RS256 signe par Atlassian, verifie via JWKS).
    if (looksLikeForgeToken(token)) {
      const p = await verifyForgeToken(token);
      const orgId = await orgForCloud(p.context?.cloudId ?? p.app?.installationId);
      req.auth = { userId: null, orgId, role: 'agent', via: 'forge', scopes: ['read', 'write'], forge: { principal: p.principal ?? null } };
      return;
    }

    const claims = await verifyAccess(token);
    // Re-lecture du role : un utilisateur retire/desactive perd l'acces avant l'expiration du JWT.
    const row = await one(
      `SELECT m.role, u.disabled FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.user_id=$1 AND m.org_id=$2`,
      [claims.userId, claims.orgId],
    );
    if (!row || row.disabled) throw unauthorized('Acces revoque');
    req.auth = { userId: claims.userId, orgId: claims.orgId, role: row.role, via: 'session', scopes: ['read', 'write', 'admin'] };
  });

  /** Garde de role minimal + portee d'API ('read' pour GET, 'write' sinon, 'admin' si role admin requis). */
  app.decorate('guard', (minRole = 'viewer') => async (req) => {
    await app.authenticate(req);
    if (ROLE_RANK[req.auth.role] < ROLE_RANK[minRole]) throw new AppError(403, 'insufficient_role', 'Role insuffisant');
    if (req.auth.via === 'apikey') {
      const need = ROLE_RANK[minRole] >= ROLE_RANK.admin ? 'admin' : req.method === 'GET' ? 'read' : 'write';
      const have = req.auth.scopes;
      const ok = have.includes('admin') || have.includes(need) || (need === 'read' && have.includes('write'));
      if (!ok) throw forbidden(`Portee d'API requise: ${need}`);
    }
  });
}

export default fp(plugin, { name: 'auth' });
export { ROLE_RANK };
