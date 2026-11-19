import { z } from 'zod';
import { env } from '../config/env.js';
import { many, one } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { excerpt } from '../lib/text.js';
import { searchKb } from './core.js';

const tight = { config: { rateLimit: { max: env.strictRate * 2, timeWindow: '1 minute' } } };

// Surface publique minimale : aucune donnee interne, aucun identifiant sequentiel, jetons opaques.
const STAGE = {
  open: { stage: 'in_progress', label: 'Pris en charge par notre equipe' },
  pending: { stage: 'waiting_on_you', label: 'Nous attendons votre retour' },
  resolved: { stage: 'resolved', label: 'Resolu' },
  closed: { stage: 'closed', label: 'Clos' },
};

export default async function publicRoutes(app) {
  // 19. Lien de suivi : "ou en est ma demande ?" sans compte, sans fuite d'information interne.
  app.get('/public/track/:token', tight, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(80) }).parse(req.params);
    const link = await one('SELECT ticket_id FROM share_links WHERE token_hash=$1 AND expires_at > now()', [sha256(token)]);
    if (!link) throw notFound('Lien invalide ou expire'); // meme reponse : inconnu / expire
    const t = await one('SELECT id, key, title, status, priority, created_at, resolved_at, first_response_at FROM tickets WHERE id=$1', [link.ticket_id]);
    const last = await one(`SELECT body, created_at FROM ticket_comments WHERE ticket_id=$1 AND NOT internal AND NOT author_is_customer ORDER BY created_at DESC LIMIT 1`, [t.id]);
    const steps = await many(`SELECT type, created_at FROM ticket_events WHERE ticket_id=$1 AND type IN ('created','status_changed','reopened') ORDER BY id`, [t.id]);
    return {
      reference: t.key, title: t.title, ...STAGE[t.status], createdAt: t.created_at, firstResponseAt: t.first_response_at, resolvedAt: t.resolved_at,
      lastUpdate: last ? { at: last.created_at, message: excerpt(last.body, 400) } : null,
      timeline: steps.map((s) => ({ at: s.created_at, event: s.type })),
    };
  });

  // 26. Deflexion avant soumission : suggestions de la base de connaissances pendant la saisie.
  app.post('/public/portal/:slug/suggest', tight, async (req) => {
    const { slug } = z.object({ slug: z.string().max(60) }).parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(8).max(500) }).parse(req.body);
    const org = await one('SELECT id, settings FROM orgs WHERE slug=$1', [slug]);
    if (!org || org.settings?.portalEnabled !== true) throw notFound('Portail indisponible');
    const arts = await searchKb(org.id, text, 3);
    return { suggestions: arts.filter((a) => a.score >= 0.3).map((a) => ({ title: a.title, url: a.url, excerpt: excerpt(a.body, 220), relevance: a.score })) };
  });
}
