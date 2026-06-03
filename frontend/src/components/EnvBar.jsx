/**
 * EnvBar — environment selector shown at the top of env-specific pages.
 * Appears between the breadcrumb and the section content.
 */
export default function EnvBar({ envs = [], activeEnv, onEnvChange, hint }) {
  if (!envs || envs.length === 0) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 16px',
      background: 'var(--color-background-secondary)',
      border: '1px solid var(--color-border-secondary)',
      borderRadius: '10px',
      marginBottom: '20px',
    }}>
      <i className="ti ti-server-2" style={{ fontSize: 16, color: 'var(--accent)', flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 500, flexShrink: 0 }}>
        {hint || 'Select environment:'}
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {envs.map(env => (
          <button key={env} onClick={() => onEnvChange(env)}
            style={{
              padding: '4px 16px', borderRadius: 20,
              border: `1.5px solid ${activeEnv === env ? 'var(--accent)' : 'var(--color-border-secondary)'}`,
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: activeEnv === env ? 'var(--accent)' : 'transparent',
              color: activeEnv === env ? 'var(--btn-primary-text)' : 'var(--color-text-secondary)',
              transition: 'all .15s',
            }}>
            {env}
          </button>
        ))}
      </div>
      {!activeEnv && (
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontStyle: 'italic', marginLeft: 4 }}>
          ← pick one to get started
        </span>
      )}
    </div>
  );
}
