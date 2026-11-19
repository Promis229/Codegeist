import { z } from 'zod';
import { one, query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { IMAGE_MIMES, inspectFile, scanFile } from '../lib/upload.js';

const MAX_AVATAR = 600 * 1024; // le navigateur redimensionne en 256 px : une photo normale pèse ~30 Ko

export default async function profileRoutes(app) {
  const guard = { preHandler: app.guard('viewer') };

  // Téléverser ou remplacer sa photo : mêmes contrôles que les pièces jointes, mais images raster uniquement.
  app.put('/me/avatar', { ...guard, bodyLimit: 1_500_000 }, async (req) => {
    const { data } = z.object({ data: z.string().min(16).max(1_000_000) }).parse(req.body);
    const buf = Buffer.from(data, 'base64');
    if (buf.length > MAX_AVATAR) throw badRequest('Photo trop volumineuse (600 Ko maximum)');
    const { mime } = inspectFile(buf, 'avatar', { only: IMAGE_MIMES });
    await scanFile(buf);
    await query(
      `INSERT INTO user_avatars(user_id, mime, size, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET mime=EXCLUDED.mime, size=EXCLUDED.size, data=EXCLUDED.data, updated_at=now()`,
      [req.auth.userId, mime, buf.length, buf],
    );
    const avatarUrl = `/users/${req.auth.userId}/avatar?v=${Date.now()}`;
    await query('UPDATE users SET avatar_url=$2 WHERE id=$1', [req.auth.userId, avatarUrl]);
    await audit(req.auth.orgId, req.auth.userId, 'profile.avatar_set', 'user', req.auth.userId);
    return { avatarUrl };
  });

  app.delete('/me/avatar', guard, async (req) => {
    await query('DELETE FROM user_avatars WHERE user_id=$1', [req.auth.userId]);
    await query('UPDATE users SET avatar_url=NULL WHERE id=$1', [req.auth.userId]);
    return { ok: true };
  });

  // Lecture : soi-même ou un collègue d'une organisation commune (les photos ne sont jamais publiques).
  app.get('/users/:id/avatar', guard, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (id !== req.auth.userId) {
      const shared = await one('SELECT 1 AS ok FROM memberships a JOIN memberships b ON a.org_id=b.org_id WHERE a.user_id=$1 AND b.user_id=$2 LIMIT 1', [req.auth.userId, id]);
      if (!shared) throw notFound('Photo introuvable');
    }
    const a = await one('SELECT mime, size, data FROM user_avatars WHERE user_id=$1', [id]);
    if (!a) throw notFound('Photo introuvable');
    reply.header('Content-Type', a.mime).header('Content-Length', a.size).header('Content-Disposition', 'inline')
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Cache-Control', 'private, max-age=86400');
    return reply.send(a.data);
  });
}
