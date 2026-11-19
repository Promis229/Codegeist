import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, post, restore, tokens } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

const RANK = { viewer: 0, agent: 1, admin: 2, owner: 3 };

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', me: null });

  const loadMe = useCallback(async () => {
    const me = await get('/auth/me');
    setState({ status: 'in', me });
    return me;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (await restore()) { try { await loadMe(); return; } catch { /* retombe sur deconnecte */ } }
      if (alive) setState({ status: 'out', me: null });
    })();
    const off = tokens.onLogout(() => setState({ status: 'out', me: null }));
    return () => { alive = false; off(); };
  }, [loadMe]);

  const value = useMemo(() => ({
    ...state,
    /** Session de la démonstration : compte @kairos.dev dans l'organisation d'exemple « acme » (seul le jeu de démo les crée). */
    isDemo: !!state.me && state.me.user.email.endsWith('@kairos.dev') && state.me.orgs.find((o) => o.id === state.me.activeOrgId)?.slug === 'acme',
    can:(role) => (RANK[state.me?.role] ?? -1) >= RANK[role],
    /** Termine une connexion : stocke les jetons puis charge le profil. */
    async completeLogin(session) { tokens.set(session); return loadMe(); },
    async logout() {
      const rt = localStorage.getItem('kairos.refresh');
      if (rt) await post('/auth/logout', { refreshToken: rt }).catch(() => {});
      tokens.clear();
    },
    async switchOrg(orgId) { const r = await post('/auth/switch-org', { orgId }); tokens.set({ accessToken: r.accessToken }); return loadMe(); },
    reload: loadMe,
  }), [state, loadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
