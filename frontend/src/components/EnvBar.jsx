/**
 * EnvBar — environment (and, when a project has more than one, collection) selector shown
 * at the top of env-specific pages. Appears between the breadcrumb and the section content.
 *
 * Collection switching: a project's data (runs, rules, config, alerts...) is always scoped
 * to ONE collection + ONE env at a time, but there was previously no way to switch which
 * collection was active anywhere in the UI — it was silently auto-selected once and never
 * changeable. A project with 2+ collections (e.g. one per release/environment) had every
 * collection except whichever got auto-selected permanently invisible on every page that
 * renders this bar. The dropdown below is only shown when there's something to switch between.
 */
export default function EnvBar({ envs = [], activeEnv, onEnvChange, hint, collections, activeCollectionId, onCollectionChange }) {
  const showCollectionPicker = Array.isArray(collections) && collections.length > 1 && typeof onCollectionChange === 'function';

  if ((!envs || envs.length === 0) && !showCollectionPicker) return null;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '10px 16px',
      background: 'var(--color-background-secondary)',
      border: '1px solid var(--color-border-secondary)',
      borderRadius: '10px',
      marginBottom: '20px',
    }}>
      {showCollectionPicker && (
        <>
          <i className="ti ti-braces" style={{ fontSize: 16, color: 'var(--accent)', flexShrink: 0 }} />
          <select
            value={activeCollectionId ?? ''}
            onChange={e => {
              const col = collections.find(c => String(c.id) === e.target.value);
              if (col) onCollectionChange(col);
            }}
            style={{
              padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: '1.5px solid var(--color-border-secondary)',
              background: 'var(--color-background-primary)', color: 'var(--color-text-primary)',
              cursor: 'pointer', flexShrink: 0, width: 'auto', maxWidth: 260,
            }}>
            {collections.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--color-border-secondary)', flexShrink: 0 }} />
        </>
      )}
      {envs && envs.length > 0 && <>
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
      </>}
    </div>
  );
}
