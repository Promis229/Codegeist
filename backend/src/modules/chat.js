import { z } from 'zod';
import { many, one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { excerpt } from '../lib/text.js';
import { IMAGE_MIMES, inspectFile, scanFile } from '../lib/upload.js';

const uuid = z.string().uuid();
const KEY_RE = /\b[A-Z]{2,5}-\d{1,7}\b/g;
const PROTECTED = new Set(['general']);

// ---------------------------------------------------------------- pièces jointes (contrôles de sécurité : lib/upload.js)
const MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 8 * 1024 * 1024, MAX_FILES = 4;
const ORG_QUOTA = Number(process.env.CHAT_QUOTA_MB || 1024) * 1024 * 1024; // stockage total des pièces jointes par organisation

const MSG_SELECT = `
  SELECT m.id, m.author_id, u.display_name AS author_name, u.avatar_url AS author_avatar, m.body, m.created_at, m.edited_at, m.reply_to,
         rp.body AS reply_body, ru.display_name AS reply_author,
         EXISTS (SELECT 1 FROM chat_attachments x WHERE x.message_id = rp.id) AS reply_files,
         (SELECT coalesce(json_agg(json_build_object('id', a.id, 'name', a.name, 'mime', a.mime, 'size', a.size) ORDER BY a.created_at), '[]'::json)
            FROM chat_attachments a WHERE a.message_id = m.id) AS attachments
    FROM chat_messages m
    LEFT JOIN users u ON u.id = m.author_id
    LEFT JOIN chat_messages rp ON rp.id = m.reply_to
    LEFT JOIN users ru ON ru.id = rp.author_id`;

/** Salon par defaut + rattachement de l'utilisateur a tous les salons (l'historique deja ecrit compte comme lu). */
async function ensureMembership(orgId, userId) {
  await query(
    `INSERT INTO chat_channels(org_id, kind, name, created_by) VALUES ($1,'channel','general',$2) ON CONFLICT (org_id, name) WHERE kind='channel' DO NOTHING`,
    [orgId, userId],
  );
  await query(
    `INSERT INTO chat_members(channel_id, user_id, last_read_id)
       SELECT c.id, $2, coalesce((SELECT max(m.id) FROM chat_messages m WHERE m.channel_id=c.id), 0)
         FROM chat_channels c WHERE c.org_id=$1 AND c.kind='channel' ON CONFLICT DO NOTHING`,
    [orgId, userId],
  );
}

async function channelFor(req, id) {
  const c = await one('SELECT * FROM chat_channels WHERE id=$1 AND org_id=$2', [id, req.auth.orgId]);
  // Un message direct n'existe que pour ses deux participants ; pour les autres il « n'existe pas ».
  if (!c || (c.kind === 'dm' && !c.dm_key.split(':').includes(req.auth.userId))) throw notFound('Conversation introuvable');
  return c;
}

const shape = (m) => ({
  id: Number(m.id), authorId: m.author_id, authorName: m.author_name ?? null, authorAvatar: m.author_avatar ?? null, body: m.body, createdAt: m.created_at, editedAt: m.edited_at,
  attachments: m.attachments ?? [],
  // Message cité (« répondre » façon messagerie) ; null si le message d'origine a été supprimé.
  replyTo: m.reply_to && m.reply_author !== undefined && m.reply_body !== null
    ? { id: Number(m.reply_to), authorName: m.reply_author ?? null, body: excerpt(m.reply_body, 140), files: !!m.reply_files } : null,
});

/** Reference les demandes citees dans les messages (ex. ACM-12) pour que l'interface les rende cliquables. */
async function citedTickets(orgId, messages) {
  const keys = [...new Set(messages.flatMap((m) => m.body.match(KEY_RE) ?? []))].slice(0, 100);
  if (!keys.length) return {};
  const rows = await many('SELECT id, key, title, status FROM tickets WHERE org_id=$1 AND key = ANY($2)', [orgId, keys]);
  return Object.fromEntries(rows.map((t) => [t.key, { id: t.id, title: t.title, status: t.status }]));
}

export default async function chatRoutes(app) {
  const read = { preHandler: app.guard('viewer') };
  const write = { preHandler: app.guard('agent') };
  const limited = { preHandler: app.guard('agent'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get('/chat/channels', read, async (req) => {
    const { orgId, userId } = req.auth;
    await ensureMembership(orgId, userId);
    const rows = await many(
      `SELECT c.id, c.kind, c.name, c.topic, c.dm_key, c.created_at,
              (SELECT count(*) FROM chat_messages m WHERE m.channel_id=c.id AND m.id > cm.last_read_id AND m.author_id IS DISTINCT FROM $2)::int AS unread,
              lm.body AS last_body, lm.created_at AS last_at, lm.author_id AS last_author
         FROM chat_channels c
         JOIN chat_members cm ON cm.channel_id=c.id AND cm.user_id=$2
         LEFT JOIN LATERAL (SELECT body, created_at, author_id, EXISTS (SELECT 1 FROM chat_attachments a WHERE a.message_id = chat_messages.id) AS has_files
                              FROM chat_messages WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) lm ON true
        WHERE c.org_id=$1
        ORDER BY coalesce(lm.created_at, c.created_at) DESC`,
      [orgId, userId],
    );
    const peerIds = rows.filter((r) => r.kind === 'dm').map((r) => r.dm_key.split(':').find((x) => x !== userId));
    const peers = peerIds.length ? await many('SELECT id, display_name FROM users WHERE id = ANY($1)', [peerIds]) : [];
    const name = new Map(peers.map((p) => [p.id, p.display_name]));
    const channels = rows.map((r) => {
      const peerId = r.kind === 'dm' ? r.dm_key.split(':').find((x) => x !== userId) : null;
      return {
        id: r.id, kind: r.kind, name: r.name, topic: r.topic, unread: r.unread,
        peer: peerId ? { id: peerId, name: name.get(peerId) ?? null } : null,
        last: r.last_at ? { body: r.last_body.slice(0, 140), at: r.last_at, mine: r.last_author === userId, files: r.has_files } : null,
      };
    });
    return { channels, unread: channels.reduce((s, c) => s + c.unread, 0) };
  });

  // Compteur leger pour le badge de la navigation (interroge souvent).
  app.get('/chat/unread', read, async (req) => {
    const r = await one(
      `SELECT count(*)::int AS n FROM chat_messages m
         JOIN chat_members cm ON cm.channel_id=m.channel_id AND cm.user_id=$2
         JOIN chat_channels c ON c.id=m.channel_id AND c.org_id=$1
        WHERE m.id > cm.last_read_id AND m.author_id IS DISTINCT FROM $2`,
      [req.auth.orgId, req.auth.userId],
    );
    return { unread: r.n };
  });

  app.post('/chat/channels', { preHandler: app.guard('admin') }, async (req, reply) => {
    const b = z.object({
      name: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, 'Nom invalide : lettres, chiffres et tirets'),
      topic: z.string().trim().max(200).optional(),
    }).parse(req.body);
    const taken = await one(`SELECT 1 FROM chat_channels WHERE org_id=$1 AND kind='channel' AND name=$2`, [req.auth.orgId, b.name]);
    if (taken) throw conflict('Ce salon existe deja');
    const c = await one(`INSERT INTO chat_channels(org_id, kind, name, topic, created_by) VALUES ($1,'channel',$2,$3,$4) RETURNING id, name, topic`, [req.auth.orgId, b.name, b.topic ?? null, req.auth.userId]);
    await query('INSERT INTO chat_members(channel_id, user_id) VALUES ($1,$2)', [c.id, req.auth.userId]);
    await audit(req.auth.orgId, req.auth.userId, 'chat.channel_created', 'chat_channel', c.id, { name: b.name });
    reply.code(201);
    return { id: c.id, kind: 'channel', name: c.name, topic: c.topic, unread: 0, peer: null, last: null };
  });

  app.delete('/chat/channels/:id', { preHandler: app.guard('admin') }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = await channelFor(req, id);
    if (c.kind !== 'channel' || PROTECTED.has(c.name)) throw forbidden('Ce salon ne peut pas etre supprime');
    await query('DELETE FROM chat_channels WHERE id=$1', [id]);
    await audit(req.auth.orgId, req.auth.userId, 'chat.channel_deleted', 'chat_channel', id, { name: c.name });
    return { ok: true };
  });

  app.post('/chat/dm', write, async (req, reply) => {
    const { userId: peer } = z.object({ userId: uuid }).parse(req.body);
    if (peer === req.auth.userId) throw forbidden('Impossible de s\'ecrire a soi-meme');
    const member = await one('SELECT u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND u.disabled=false', [req.auth.orgId, peer]);
    if (!member) throw notFound('Membre introuvable');
    const key = [req.auth.userId, peer].sort().join(':');
    await query(`INSERT INTO chat_channels(org_id, kind, dm_key, created_by) VALUES ($1,'dm',$2,$3) ON CONFLICT (org_id, dm_key) WHERE kind='dm' DO NOTHING`, [req.auth.orgId, key, req.auth.userId]);
    const c = await one(`SELECT id FROM chat_channels WHERE org_id=$1 AND kind='dm' AND dm_key=$2`, [req.auth.orgId, key]);
    await query('INSERT INTO chat_members(channel_id, user_id) VALUES ($1,$2), ($1,$3) ON CONFLICT DO NOTHING', [c.id, req.auth.userId, peer]);
    reply.code(200);
    return { id: c.id, kind: 'dm', name: null, topic: null, unread: 0, peer: { id: peer, name: member.display_name }, last: null };
  });

  app.get('/chat/channels/:id/messages', read, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({
      after: z.coerce.number().int().min(0).optional(), before: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const c = await channelFor(req, id);
    let rows;
    if (q.after !== undefined) {
      rows = await many(`${MSG_SELECT} WHERE m.channel_id=$1 AND m.id > $2 ORDER BY m.id ASC LIMIT $3`, [id, q.after, q.limit]);
    } else {
      rows = (await many(`${MSG_SELECT} WHERE m.channel_id=$1 AND ($2::bigint IS NULL OR m.id < $2) ORDER BY m.id DESC LIMIT $3`, [id, q.before ?? null, q.limit])).reverse();
    }
    const messages = rows.map(shape);
    const me = await one('SELECT last_read_id FROM chat_members WHERE channel_id=$1 AND user_id=$2', [id, req.auth.userId]);
    return {
      channel: { id: c.id, kind: c.kind, name: c.name, topic: c.topic },
      messages, hasMore: q.after === undefined && rows.length === q.limit,
      lastReadId: Number(me?.last_read_id ?? 0), tickets: await citedTickets(req.auth.orgId, messages),
    };
  });

  // Les pièces jointes voyagent en base64 dans le JSON (aucun module de téléversement à déployer) : limite relevée sur cette seule route.
  app.post('/chat/channels/:id/messages', { ...limited, bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      body: z.string().trim().max(4000).default(''),
      replyTo: z.number().int().min(1).optional(),
      attachments: z.array(z.object({ name: z.string().min(1).max(260), data: z.string().min(4) })).max(MAX_FILES).default([]),
    }).parse(req.body);
    if (!b.body && !b.attachments.length) throw badRequest('Message vide');
    await channelFor(req, id);
    if (b.replyTo && !(await one('SELECT 1 AS ok FROM chat_messages WHERE id=$1 AND channel_id=$2', [b.replyTo, id]))) throw badRequest('Le message cité n\'existe plus');

    let total = 0;
    const files = [];
    for (const a of b.attachments) {
      const data = Buffer.from(a.data, 'base64');
      if (data.length > MAX_FILE) throw badRequest('Fichier trop volumineux (5 Mo maximum)');
      total += data.length;
      const { mime, name } = inspectFile(data, a.name); // type réel, formats actifs refusés, nom assaini
      files.push({ name, mime, data });
    }
    if (total > MAX_TOTAL) throw badRequest('Pièces jointes trop volumineuses (8 Mo au total)');
    if (files.length) {
      const used = await one(
        `SELECT coalesce(sum(a.size), 0)::bigint AS n FROM chat_attachments a JOIN chat_messages m ON m.id=a.message_id JOIN chat_channels c ON c.id=m.channel_id WHERE c.org_id=$1`, [req.auth.orgId]);
      if (Number(used.n) + total > ORG_QUOTA) throw badRequest('Espace de stockage de la messagerie plein pour cette organisation');
      for (const f of files) await scanFile(f.data); // antivirus ClamAV si configuré (CLAMD_HOST)
    }

    const mid = await tx(async (db) => {
      const m = await db.one('INSERT INTO chat_messages(channel_id, author_id, body, reply_to) VALUES ($1,$2,$3,$4) RETURNING id', [id, req.auth.userId, b.body, b.replyTo ?? null]);
      for (const f of files) await db.query('INSERT INTO chat_attachments(message_id, name, mime, size, data) VALUES ($1,$2,$3,$4,$5)', [m.id, f.name, f.mime, f.data.length, f.data]);
      return m.id;
    });
    await query(
      `INSERT INTO chat_members(channel_id, user_id, last_read_id) VALUES ($1,$2,$3)
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_id = GREATEST(chat_members.last_read_id, EXCLUDED.last_read_id)`,
      [id, req.auth.userId, mid],
    );
    const m = await one(`${MSG_SELECT} WHERE m.id=$1`, [mid]);
    reply.code(201);
    return { ...shape(m), tickets: await citedTickets(req.auth.orgId, [m]) };
  });

  // Téléchargement : authentifié et limité aux membres de la conversation. Les images s'affichent, le reste se télécharge ;
  // « sandbox » + nosniff empêchent toute exécution dans le navigateur.
  app.get('/chat/attachments/:id', read, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const a = await one('SELECT a.name, a.mime, a.size, a.data, m.channel_id FROM chat_attachments a JOIN chat_messages m ON m.id=a.message_id WHERE a.id=$1', [id]);
    if (!a) throw notFound('Fichier introuvable');
    await channelFor(req, a.channel_id);
    const inline = IMAGE_MIMES.has(a.mime);
    reply.header('Content-Type', a.mime).header('Content-Length', a.size)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`)
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Cache-Control', 'private, max-age=3600');
    return reply.send(a.data);
  });

  app.post('/chat/channels/:id/read', read, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { upTo } = z.object({ upTo: z.number().int().min(0).optional() }).parse(req.body ?? {});
    await channelFor(req, id);
    const r = await one(
      `INSERT INTO chat_members(channel_id, user_id, last_read_id)
       VALUES ($1,$2, LEAST(coalesce($3::bigint, (SELECT max(id) FROM chat_messages WHERE channel_id=$1), 0), coalesce((SELECT max(id) FROM chat_messages WHERE channel_id=$1), 0)))
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_id = GREATEST(chat_members.last_read_id, EXCLUDED.last_read_id)
       RETURNING last_read_id`,
      [id, req.auth.userId, upTo ?? null],
    );
    return { lastReadId: Number(r.last_read_id) };
  });

  const ownMessage = async (req, id) => {
    const m = await one(
      `SELECT m.id, m.author_id, m.channel_id FROM chat_messages m JOIN chat_channels c ON c.id=m.channel_id WHERE m.id=$1 AND c.org_id=$2`,
      [id, req.auth.orgId],
    );
    if (!m) throw notFound('Message introuvable');
    await channelFor(req, m.channel_id);
    return m;
  };

  app.patch('/chat/messages/:id', write, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().min(1) }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const m = await ownMessage(req, id);
    if (m.author_id !== req.auth.userId) throw forbidden('Seul l\'auteur peut modifier son message');
    await query('UPDATE chat_messages SET body=$2, edited_at=now() WHERE id=$1', [id, body]);
    return shape(await one(`${MSG_SELECT} WHERE m.id=$1`, [id]));
  });

  app.delete('/chat/messages/:id', write, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().min(1) }).parse(req.params);
    const m = await ownMessage(req, id);
    const isAdmin = ['admin', 'owner'].includes(req.auth.role);
    if (m.author_id !== req.auth.userId && !isAdmin) throw forbidden('Seul l\'auteur ou un administrateur peut supprimer ce message');
    await query('DELETE FROM chat_messages WHERE id=$1', [id]);
    return { ok: true };
  });
}
