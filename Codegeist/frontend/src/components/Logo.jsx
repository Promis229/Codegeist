/**
 * Marque Kairos : un cadran solaire dont l'ombre dessine un K.
 * La tige est le gnomon, le bras ambre est la lumiere, le bras pale est l'ombre qui se deplace :
 * kairos, c'est le moment opportun, celui que mesure l'ombre.
 */
export function Mark({ size = 36, animated = true, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className} role="img" aria-label="Kairos">
      <g className={animated ? 'dial-ring' : ''}>
        <circle cx="32" cy="32" r="26" stroke="var(--accent)" strokeOpacity=".28" strokeWidth="1.6" strokeDasharray="1.5 5.2" strokeLinecap="round" />
      </g>
      <circle cx="32" cy="32" r="21" stroke="var(--accent)" strokeOpacity=".4" strokeWidth="1.6" />
      <path d="M23 15v34" stroke="var(--text)" strokeWidth="5" strokeLinecap="round" />
      <path d="M25 33 44 16" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />
      <path className={animated ? 'dial-shadow' : ''} d="M25 33 45 49" stroke="var(--text)" strokeOpacity=".42" strokeWidth="5" strokeLinecap="round" />
      <circle cx="25" cy="33" r="2.4" fill="var(--accent-2)" />
    </svg>
  );
}

export function Logo({ size = 30, withName = true }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark size={size} />
      {withName && <span className="font-serif text-[22px] tracking-tight" style={{ fontVariationSettings: '"opsz" 72, "SOFT" 60' }}>Kairos</span>}
    </span>
  );
}
