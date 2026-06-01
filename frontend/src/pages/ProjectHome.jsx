export default function ProjectHome({ project, onNav, onDeleteProject, onEditProject }) {
  if (!project) return (
    <div className="page"><div className="empty"><div className="empty-title">Select a project from the sidebar</div></div></div>
  );

  const p = project;

  const statCards = [
    { label: 'API Source',  icon: 'ti-braces',                  color: 'var(--accent)',  val: p.collections?.length || 0, sub: 'Manage →',  page: 'collections' },
    { label: 'Rules',        icon: 'ti-adjustments-horizontal', color: '#f0a732',        val: p.rules?.length || 0,       sub: 'Configure →', page: 'rules' },
    { label: 'Test Plans',   icon: 'ti-test-pipe',              color: '#5fc978',        val: '—',                        sub: 'Generate →', page: 'test-suites' },
    { label: 'Test Data',    icon: 'ti-table',                  color: '#ef9f27',        val: '—',                        sub: 'Upload →',  page: 'test-data' },
  ];

  return (
    <div className="page fade-in">
      <div className="breadcrumb">
        <a onClick={() => onNav('dashboard')}><i className="ti ti-layout-dashboard" style={{ marginRight: '4px', fontSize: '12px' }} />Dashboard</a>
        <i className="ti ti-chevron-right" style={{ fontSize: '12px' }} />
        <span>{p.name}</span>
      </div>

      <div className="card" style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div className="proj-icon" style={{ background: p.bg, width: '48px', height: '48px', fontSize: '22px' }}>
            <i className="ti ti-folder" style={{ color: p.color }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '18px', fontWeight: 600 }}>{p.name}</div>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: '13px', marginTop: '2px' }}>{p.description || 'No description'}</div>
          </div>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
            background: 'rgba(95,201,120,0.18)', color: '#5fc978',
            border: '1px solid rgba(95,201,120,0.45)',
          }}>
            <i className="ti ti-circle-check" style={{ fontSize: '13px' }} /> Active
          </span>
          {onEditProject && (
            <button
              className="btn-secondary btn-sm"
              style={{ marginLeft: '8px' }}
              onClick={() => onEditProject(p)}
            >
              <i className="ti ti-pencil" /> Edit Project
            </button>
          )}
          {onDeleteProject && (
            <button
              className="btn-secondary btn-sm"
              style={{ color: 'var(--danger, #f75464)', borderColor: 'rgba(247,84,100,0.3)', marginLeft: '8px' }}
              onClick={() => onDeleteProject(p.id)}
            >
              <i className="ti ti-trash" /> Delete Project
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginBottom: '24px' }}>
        {statCards.map(sc => (
          <div key={sc.page} className="stat-card" style={{ cursor: 'pointer' }} onClick={() => onNav(sc.page)}>
            <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <i className={`ti ${sc.icon}`} style={{ color: sc.color, fontSize: '12px' }} />
              {sc.label}
            </div>
            <div className="stat-val">{sc.val}</div>
            <div className="stat-sub" style={{ color: 'var(--accent)' }}>{sc.sub}</div>
          </div>
        ))}
      </div>

    </div>
  );
}
