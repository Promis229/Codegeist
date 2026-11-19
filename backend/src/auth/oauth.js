import { z } from 'zod';
import { env } from '../config/env.js';
import { one, query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { pkce, randomToken } from '../lib/crypto.js';
import { AppError, badRequest } from '../lib/errors.js';
import { createUserWithOrg, startSession } from './service.js';
import { signPurpose, verifyPurpose } from './tokens.js';

const ALLOWED_REDIRECTS = () => [`${env.webUrl}/auth/callback`, 'kairos://auth/callback'];

// En test uniquement, les fournisseurs sont remplaces par un faux serveur local (OAUTH_TEST_BASE) : on verifie tout le flux
// (PKCE, etat signe, echange du code, profil, liaison de compte) sans identifiants reels. Ignore hors test.
const testBase = () => (env.isTest ? process.env.OAUTH_TEST_BASE || '' : '');

const PROVIDERS = {
  google: {
    cfg: () => env.google,
    authUrl: () => testBase() ? `${testBase()}/google/auth` : 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => testBase() ? `${testBase()}/google/token` : 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    extra: { access_type: 'online', prompt: 'select_account' },
    async profile(accessToken) {
      const url = testBase() ? `${testBase()}/google/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo';
      const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new AppError(502, 'oauth_upstream', 'Profil Google indisponible');
      const p = await r.json();
      return { id: p.sub, email: p.email, emailVerified: p.email_verified === true, name: p.name ?? p.email, avatar: p.picture };
    },
  },
  github: {
    cfg: () => env.github,
    authUrl: () => testBase() ? `${testBase()}/github/auth` : 'https://github.com/login/oauth/authorize',
    tokenUrl: () => testBase() ? `${testBase()}/github/token` : 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    extra: {},
    async profile(accessToken) {
      const api = testBase() ? `${testBase()}/github` : 'https://api.github.com';
      const h = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'kairos' };
      const [u, e] = await Promise.all([fetch(`${api}/user`, { headers: h }), fetch(`${api}/user/emails`, { headers: h })]);
      if (!u.ok || !e.ok) throw new AppError(502, 'oauth_upstream', 'Profil GitHub indisponible');
      const user = await u.json();
      const emails = await e.json();
      // On ne fait confiance qu'a un email principal VERIFIE (sinon risque de prise de controle de compte).
      const primary = emails.find((x) => x.primary && x.verified);
      return { id: String(user.id), email: primary?.email ?? null, emailVerified: !!primary, name: user.name ?? user.login, avatar: user.avatar_url };
    },
  },
};

const enabled = (p) => !!(p.cfg().id && p.cfg().secret);

export default async function oauthRoutes(app) {
  app.get('/auth/providers', async () => ({
    providers: Object.entries(PROVIDERS).map(([name, p]) => ({ name, enabled: enabled(p) })),
    demo: env.demoLogin,
  }));

  app.get('/auth/oauth/:provider/start', { config: { rateLimit: { max: env.strictRate * 2, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { provider } = z.object({ provider: z.enum(['google', 'github']) }).parse(req.params);
    const { redirect } = z.object({ redirect: z.string().optional() }).parse(req.query);
    const p = PROVIDERS[provider];
    if (!enabled(p)) throw new AppError(501, 'oauth_not_configured', `${provider} n'est pas configure sur ce serveur`);
    const target = redirect ?? ALLOWED_REDIRECTS()[0];
    if (!ALLOWED_REDIRECTS().includes(target)) throw badRequest('redirect non autorise'); // anti open-redirect
    const verifier = pkce.verifier();
    const state = await signPurpose('oauth', { provider, verifier, redirect: target, nonce: randomToken(8) }, 600);
    const url = new URL(p.authUrl());
    url.search = new URLSearchParams({
      client_id: p.cfg().id,
      redirect_uri: `${env.publicUrl}/api/v1/auth/oauth/${provider}/callback`,
      response_type: 'code', scope: p.scope, state,
      code_challenge: pkce.challenge(verifier), code_challenge_method: 'S256', ...p.extra,
    }).toString();
    return reply.redirect(url.toString());
  });

  // Le navigateur arrive ici depuis le fournisseur : en cas d'echec (acces refuse, email non verifie, etat invalide…) on
  // le renvoie vers l'APPLICATION avec un code d'erreur dans le fragment, jamais vers une page JSON brute.
  app.get('/auth/oauth/:provider/callback', { config: { rateLimit: { max: env.strictRate * 2, timeWindow: '1 minute' } } }, async (req, reply) => {
    const back = (code, redirect = ALLOWED_REDIRECTS()[0]) => reply.redirect(`${redirect}#${new URLSearchParams({ error: code })}`);
    const parsedProvider = z.enum(['google', 'github']).safeParse(req.params.provider);
    if (!parsedProvider.success) return back('oauth_refused');
    const provider = parsedProvider.data;
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).safeParse(req.query);
    if (!q.success || q.data.error || !q.data.code || !q.data.state) return back('oauth_refused'); // ex. l'utilisateur a refuse l'acces
    const p = PROVIDERS[provider];

    let st;
    try { st = await verifyPurpose('oauth', q.data.state); } catch { return back('oauth_state_invalid'); }
    if (st.provider !== provider) return back('oauth_state_invalid');
    const redirect = ALLOWED_REDIRECTS().includes(st.redirect) ? st.redirect : ALLOWED_REDIRECTS()[0];

    try {
      const tokenRes = await fetch(p.tokenUrl(), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: p.cfg().id, client_secret: p.cfg().secret, code: q.data.code, grant_type: 'authorization_code',
          redirect_uri: `${env.publicUrl}/api/v1/auth/oauth/${provider}/callback`, code_verifier: st.verifier,
        }),
      });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenJson.access_token) {
        req.log.warn({ provider, status: tokenRes.status, error: tokenJson.error, description: tokenJson.error_description }, 'oauth: echange du code refuse'); // jamais de secret ni de code
        return back('oauth_exchange_failed', redirect);
      }

      const prof = await p.profile(tokenJson.access_token);
      let identity = await one('SELECT user_id FROM oauth_identities WHERE provider=$1 AND provider_user_id=$2', [provider, prof.id]);
      let userId = identity?.user_id;

      if (!userId) {
        if (!prof.email || !prof.emailVerified) return back('oauth_email_unverified', redirect);
        const existing = await one('SELECT id, email_verified FROM users WHERE email=$1', [prof.email.toLowerCase()]);
        if (existing) {
          userId = existing.id;
          if (!existing.email_verified) {
            // Anti "pre-piratage" : un tiers a pu creer ce compte avec l'email de la victime et SON mot de passe.
            // Le fournisseur prouve que l'email appartient a l'utilisateur OAuth : on efface le mot de passe
            // inconnu, on coupe toutes les sessions et on marque l'email comme verifie.
            await query('UPDATE users SET password_hash=NULL, totp_enabled=false, totp_secret_enc=NULL, email_verified=true WHERE id=$1', [existing.id]);
            await query('UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id=$1', [existing.id]);
          }
        } else {
          const created = await createUserWithOrg({ email: prof.email.toLowerCase(), displayName: prof.name, emailVerified: true, avatarUrl: prof.avatar });
          userId = created.user.id;
        }
        await query('INSERT INTO oauth_identities(user_id, provider, provider_user_id, email) VALUES ($1,$2,$3,$4)', [userId, provider, prof.id, prof.email]);
      }
      const u = await one('SELECT disabled FROM users WHERE id=$1', [userId]);
      if (u.disabled) return back('account_disabled', redirect);

      const session = await startSession(userId, { ip: req.ip, userAgent: req.headers['user-agent'] });
      await audit(session.orgId, userId, `auth.oauth_${provider}`, 'user', userId);
      // Les jetons voyagent dans le FRAGMENT (#), jamais envoyes aux serveurs ni aux journaux de proxy.
      const frag = new URLSearchParams({ access: session.accessToken, refresh: session.refreshToken }).toString();
      return reply.redirect(`${redirect}#${frag}`);
    } catch (e) {
      req.log.error({ err: e }, 'oauth callback');
      return back(e instanceof AppError && e.code === 'oauth_upstream' ? 'oauth_upstream' : 'oauth_exchange_failed', redirect);
    }
  });
}
