const SIZES = {
  xl: { icon: 40, name: 26, tagline: 12.5, attribution: 10.5, gap: 10, rowGap: 8 },
  lg: { icon: 48, name: 25, tagline: 12.5, attribution: 10.5, gap: 14, rowGap: 8 },
  md: { icon: 40, name: 24, tagline: 11, attribution: 9.5, gap: 12, rowGap: 6 },
  sm: { icon: 34, name: 24, tagline: 11, attribution: 9.5, gap: 10, rowGap: 6 },
};

/*
 * Shared Peako logo lockup — icon + wordmark + tagline + attribution.
 * Used on the sign-in screen, forgot-password screen, and the app banner
 * so the branding stays pixel-consistent instead of three hand-tuned copies.
 */
export default function Logo({ size = 'md', theme = 'dark', showTagline = true, showAttribution = true }) {
  const s = SIZES[size] || SIZES.md;
  const nameColor = theme === 'dark' ? '#fff' : 'var(--color-text-primary)';
  const taglineColor = theme === 'dark' ? 'rgba(255,255,255,0.65)' : 'var(--color-text-secondary)';
  const attributionColor = theme === 'dark' ? 'rgba(255,255,255,0.55)' : 'var(--color-text-secondary)';
  const dividerColor = theme === 'dark' ? 'rgba(255,255,255,0.4)' : 'var(--color-text-tertiary)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: s.gap }}>
      <img src="/favicon.svg" alt="Peako" style={{ height: s.icon, width: 'auto', flexShrink: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: s.rowGap }}>
        <span style={{ fontSize: s.name, fontWeight: 800, color: nameColor, letterSpacing: '-0.4px', lineHeight: 1 }}>PEAKO</span>
        {showTagline && (
          <>
            <span style={{ width: 1, height: s.name, background: dividerColor, flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <span style={{ fontSize: s.tagline, fontWeight: 500, color: taglineColor, letterSpacing: '.1px', lineHeight: 0.9 }}>
                Next Gen Performance Testing
              </span>
              {showAttribution && (
                <span style={{ fontSize: s.attribution, color: attributionColor, letterSpacing: '.2px', lineHeight: 1.3, marginTop: 2 }}>
                  by Quarks Technosoft
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
