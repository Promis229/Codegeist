export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : 0);
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function stddev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}

/** Quantile par interpolation lineaire (q dans [0,1]). */
export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Regression lineaire simple: renvoie { slope, intercept, r2 }. */
export function linreg(ys, xs = ys.map((_, i) => i)) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0, ssTot = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; ssTot += (ys[i] - my) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  const ssRes = sum(ys.map((y, i) => (y - (intercept + slope * xs[i])) ** 2));
  return { slope, intercept, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/**
 * CUSUM unilateral (hausse). Detecte un changement de regime dans une serie de comptages.
 * baseline = moyenne/ecart-type de la premiere moitie ; k = tolerance ; h = seuil d'alarme (en ecarts-types).
 * Renvoie l'indice de l'alarme (ou -1) et la serie cumulee.
 */
export function cusum(series, { k = 0.5, h = 4, baselineLen } = {}) {
  const n = baselineLen ?? Math.max(3, Math.floor(series.length / 2));
  const base = series.slice(0, n);
  const mu = mean(base);
  const sd = Math.max(stddev(base), 1); // plancher: evite l'hypersensibilite sur series plates
  let s = 0;
  const trace = [];
  let alarm = -1;
  for (let i = 0; i < series.length; i++) {
    s = Math.max(0, s + (series[i] - mu) / sd - k);
    trace.push(round(s, 3));
    if (alarm < 0 && i >= n && s > h) alarm = i;
  }
  return { alarm, mu: round(mu), sd: round(sd), trace };
}

/** Tendance sigmoide douce vers [0,1]. */
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
