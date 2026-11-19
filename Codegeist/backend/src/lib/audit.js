import { tx, many } from '../db/pool.js';
import { chainHash } from './crypto.js';

/**
 * Ajoute une entree au journal d'audit. Chaque entree contient le hash de la precedente (par organisation) :
 * modifier ou supprimer une ligne casse la chaine, ce que /audit/verify detecte.
 */
export async function audit(orgId, actor, action, entity = null, entityId = null, data = {}) {
  return tx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(orgId ?? 'global')]);
    const last = await db.one(
      'SELECT hash FROM audit_log WHERE org_id IS NOT DISTINCT FROM $1 ORDER BY id DESC LIMIT 1',
      [orgId ?? null],
    );
    const createdAt = new Date().toISOString();
    const record = { orgId: orgId ?? null, actor: actor ?? null, action, entity, entityId: entityId ? String(entityId) : null, data, createdAt };
    const hash = chainHash(last?.hash, record);
    await db.query(
      `INSERT INTO audit_log(org_id, actor, action, entity, entity_id, data, prev_hash, hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orgId ?? null, record.actor, action, entity, record.entityId, JSON.stringify(data), last?.hash ?? null, hash, createdAt],
    );
    return hash;
  });
}

/** Recalcule toute la chaine d'une organisation. Renvoie { valid, checked, brokenAt }. */
export async function verifyAuditChain(orgId) {
  const rows = await many(
    'SELECT id, org_id, actor, action, entity, entity_id, data, prev_hash, hash, created_at FROM audit_log WHERE org_id IS NOT DISTINCT FROM $1 ORDER BY id',
    [orgId ?? null],
  );
  let prev = null;
  for (const r of rows) {
    const record = {
      orgId: r.org_id ?? null, actor: r.actor ?? null, action: r.action, entity: r.entity, entityId: r.entity_id,
      data: r.data, createdAt: r.created_at.toISOString(),
    };
    if ((r.prev_hash ?? null) !== prev || chainHash(prev, record) !== r.hash) {
      return { valid: false, checked: rows.length, brokenAt: Number(r.id) };
    }
    prev = r.hash;
  }
  return { valid: true, checked: rows.length, brokenAt: null, head: prev };
}
