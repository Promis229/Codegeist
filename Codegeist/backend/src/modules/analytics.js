import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { round } from '../lib/stats.js';

export default async function analyticsRoutes(app) {
  const g = { preHandler: app.guard('viewer') };

  app.get('/analytics/overview', g, async (req) => {
    const o = req.auth.orgId;
    const [k, byStatus, byPriority, byComponent, sla, csat] = await Promise.all([
      one(`SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status IN ('open','pending'))::int AS open,
                  count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h,
                  count(*) FILTER (WHERE resolved_at > now() - interval '24 hours')::int AS resolved24h,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at))/60) AS median_first_response_min,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) AS median_resolution_h,
                  avg(frustration) FILTER (WHERE status IN ('open','pending')) AS avg_open_frustration,
                  count(*) FILTER (WHERE reopened_count > 0)::int AS reopened
             FROM tickets WHERE org_id=$1`, [o]),
      many('SELECT status, count(*)::int AS n FROM tickets WHERE org_id=$1 GROUP BY 1', [o]),
      many('SELECT priority, count(*)::int AS n FROM tickets WHERE org_id=$1 GROUP BY 1', [o]),
      many(`SELECT component, count(*)::int AS n FROM tickets WHERE org_id=$1 AND component IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 8`, [o]),
      one(`SELECT count(*) FILTER (WHERE t.resolved_at IS NOT NULL AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/60 <= p.resolve_mins)::int AS ok,
                  count(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS total
             FROM tickets t JOIN sla_policies p ON p.org_id=t.org_id AND p.priority=t.priority WHERE t.org_id=$1`, [o]),
      one(`SELECT count(*) FILTER (WHERE accepted)::int AS accepted, count(*) FILTER (WHERE accepted IS NOT NULL)::int AS rated FROM answer_provenance WHERE org_id=$1`, [o]),
    ]);
    return {
      totals: { total: k.total, open: k.open, last24h: k.last24h, resolved24h: k.resolved24h, reopened: k.reopened },
      medianFirstResponseMinutes: k.median_first_response_min == null ? null : round(k.median_first_response_min, 1),
      medianResolutionHours: k.median_resolution_h == null ? null : round(k.median_resolution_h, 1),
      avgOpenFrustration: k.avg_open_frustration == null ? 0 : round(k.avg_open_frustration, 3),
      slaCompliance: sla.total ? round(sla.ok / sla.total, 3) : null,
      aiAnswerAcceptance: csat.rated ? round(csat.accepted / csat.rated, 3) : null,
      byStatus, byPriority, byComponent,
    };
  });

  app.get('/analytics/timeseries', g, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(180).default(30) }).parse(req.query);
    const rows = await many(
      `SELECT d::date AS day,
              (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND t.created_at::date = d::date) AS created,
              (SELECT count(*)::int FROM tickets t WHERE t.org_id=$1 AND t.resolved_at::date = d::date) AS resolved
         FROM generate_series(current_date - ($2::int - 1), current_date, interval '1 day') d ORDER BY d`, [req.auth.orgId, days]);
    return { days, series: rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), created: r.created, resolved: r.resolved })) };
  });
}
