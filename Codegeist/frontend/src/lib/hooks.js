import { useCallback, useEffect, useRef, useState } from 'react';

/** Charge une ressource : { data, error, loading, reload }. Ignore les reponses obsoletes. */
export function useResource(fn, deps = []) {
  const [s, setS] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    setS((p) => ({ ...p, loading: true, error: null }));
    Promise.resolve().then(fn).then(
      (data) => { if (id === seq.current) setS({ data, error: null, loading: false }); },
      (error) => { if (id === seq.current) setS({ data: null, error, loading: false }); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...s, reload: run };
}

export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark');
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('kairos.theme', next); } catch { /* ignore */ }
    setTheme(next);
  };
  return [theme, toggle];
}

export const debounced = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
