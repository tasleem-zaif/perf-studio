import { useState, useEffect } from 'react';
import api from '../api';
import { projectDirName } from '../utils/displayName';

export default function Dashboard({ projects: propProjects, user, onSelectProject, onDeleteProject, onNewProject, onEditProject, onProjectsLoaded }) {
  const isSuperAdmin = user?.role === 'super_admin';
  const isOrgAdmin   = user?.role === 'org_admin';

  const [projects, setProjects] = useState(propProjects || []);
  const [stats,    setStats]    = useState({});
  const [loading,  setLoading]  = useState(true);
  const [backups,  setBackups]  = useState([]);
  const [backupsDir, setBackupsDir] = useState('');

  // Keep local projects in sync if parent refreshes the list
  useEffect(() => { if (propProjects?.length) setProjects(propProjects); }, [propProjects]);

  function fetchStats() {
    setLoading(true);
    // Projects already supplied by App.jsx — only fetch the 4 feature counts
    Promise.all([
      api.get('/collections'),
      api.get('/rules'),
      api.get('/test-plans'),
      api.get('/test-data'),
    ])
      .then(([colRes, ruleRes, planRes, dataRes]) => {
        const collections = colRes.data.collections  || [];
        const rules       = ruleRes.data.rules        || [];
        const testPlans   = planRes.data.test_plans   || [];
        const testData    = dataRes.data.test_data    || [];

        // Derive per-project counts from the feature responses
        const colCount  = collections.reduce((m, c) => { m[c.project_id] = (m[c.project_id] || 0) + 1; return m; }, {});
        const ruleCount = rules.reduce((m, r) => { m[r.project_id] = (m[r.project_id] || 0) + 1; return m; }, {});

        setProjects(prev => prev.map(p => ({
          ...p,
          collection_count: colCount[p.id]  || 0,
          rule_count:       ruleCount[p.id] || 0,
        })));

        const ps = propProjects || [];
        const orgCount = [...new Set(ps.map(p => p.org_name).filter(Boolean))].length;

        setStats({
          total_projects:    ps.length,
          total_collections: collections.length,
          total_rules:       rules.length,
          total_test_plans:  testPlans.length,
          total_test_data:   testData.length,
          total_orgs:        orgCount,
        });
      })
      .catch(e => console.error('Dashboard stats load failed:', e?.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchStats(); }, [propProjects?.length]);

  useEffect(() => {
    if (!isOrgAdmin && !isSuperAdmin) return;
    api.get('/projects/backups').then(r => {
      setBackups(r.data.backups || []);
      setBackupsDir(r.data.backups_dir || '');
    }).catch(() => {});
  }, []);

  const orgCount = isSuperAdmin ? (stats.total_orgs || 0) : null;

  function ProjectRow({ p }) {
    return (
      <div
        onClick={() => onSelectProject(p.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: '14px',
          padding: '12px 16px',
          background: 'var(--color-background-primary)',
          border: '1px solid var(--color-border-secondary)',
          borderLeft: '3px solid transparent',
          borderRadius: '8px',
          cursor: 'pointer',
          transition: 'background .15s, border-color .15s, box-shadow .15s, transform .15s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(34,197,94,0.04)';
          e.currentTarget.style.borderColor = 'rgba(34,197,94,0.35)';
          e.currentTarget.style.borderLeftColor = '#22c55e';
          e.currentTarget.style.boxShadow = '0 4px 16px rgba(34,197,94,0.10)';
          e.currentTarget.style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'var(--color-background-primary)';
          e.currentTarget.style.borderColor = 'var(--color-border-secondary)';
          e.currentTarget.style.borderLeftColor = 'transparent';
          e.currentTarget.style.boxShadow = 'none';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        {/* Folder icon */}
        <div style={{ width: 34, height: 34, borderRadius: 7, background: p.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <i className="ti ti-folder" style={{ color: p.color, fontSize: '17px' }} />
        </div>

        {/* Name + description */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {projectDirName(p)}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', marginTop: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.description || 'No description'}
          </div>
        </div>

        {/* Owner (admin roles only) */}
        {(isSuperAdmin || isOrgAdmin) && p.owner_name && (
          <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            <i className="ti ti-user" style={{ fontSize: '12px' }} /> {p.owner_name}
            {p.org_name && <span style={{ marginLeft: '2px' }}>· {p.org_name}</span>}
          </div>
        )}

        {/* API sources */}
        <span className="tag tag-gray" style={{ flexShrink: 0 }}>
          <i className="ti ti-braces" style={{ fontSize: '11px' }} /> {p.collection_count ?? p.collections?.length ?? 0} API sources
        </span>

        {/* Rules */}
        <span className="tag tag-gray" style={{ flexShrink: 0 }}>
          <i className="ti ti-adjustments-horizontal" style={{ fontSize: '11px' }} /> {p.rule_count ?? p.rules?.length ?? 0} rules
        </span>

        {/* Created date */}
        <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: '82px' }}>
          Created {p.created_at?.slice(0, 10)}
        </div>

        {/* Edit — org_admin only */}
        {onEditProject && (
          <button
            className="btn-secondary btn-sm"
            style={{ flexShrink: 0 }}
            onClick={e => { e.stopPropagation(); onEditProject(p); }}
          >
            <i className="ti ti-pencil" />
          </button>
        )}

        {/* Delete — org_admin only */}
        {onDeleteProject && (
          <button
            className="btn-secondary btn-sm"
            style={{ color: 'var(--danger)', borderColor: 'rgba(247,84,100,0.3)', flexShrink: 0 }}
            onClick={e => { e.stopPropagation(); onDeleteProject(p.id); }}
          >
            <i className="ti ti-trash" />
          </button>
        )}
      </div>
    );
  }



  if (loading) return (
    <div className="page fade-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 240, gap: 10, color: 'var(--color-text-secondary)' }}>
      <span className="spinner" /> Loading dashboard...
    </div>
  );

  return (
    <div className="page fade-in">
      {/* Top stats — all from a single API call */}
      <div className="stats-row">
        {isSuperAdmin && (
          <div className="stat-card">
            <div className="stat-label"><i className="ti ti-building" style={{ marginRight: '4px' }} />Organizations</div>
            <div className="stat-val">{orgCount}</div>
            <div className="stat-sub">Active</div>
          </div>
        )}
        <div className="stat-card">
          <div className="stat-label"><i className="ti ti-folder" style={{ marginRight: '4px' }} />Projects</div>
          <div className="stat-val">{stats.total_projects ?? 0}</div>
          <div className="stat-sub">{isSuperAdmin ? 'All organizations' : isOrgAdmin ? 'Your organization' : 'Active'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><i className="ti ti-braces" style={{ marginRight: '4px' }} />API Sources</div>
          <div className="stat-val">{stats.total_collections ?? 0}</div>
          <div className="stat-sub">Across all projects</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><i className="ti ti-adjustments-horizontal" style={{ marginRight: '4px' }} />Rules</div>
          <div className="stat-val">{stats.total_rules ?? 0}</div>
          <div className="stat-sub">Performance configs</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><i className="ti ti-test-pipe" style={{ marginRight: '4px' }} />Test Plans</div>
          <div className="stat-val">{stats.total_test_plans ?? 0}</div>
          <div className="stat-sub">Generated scripts</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><i className="ti ti-table" style={{ marginRight: '4px' }} />Test Data</div>
          <div className="stat-val">{stats.total_test_data ?? 0}</div>
          <div className="stat-sub">CSV datasets</div>
        </div>
      </div>

      {/* Projects flat list */}
      {projects.length === 0 ? (
        <>
          <div className="section-hdr">
            <div className="section-title"><i className="ti ti-folder" style={{ marginRight: '8px', color: 'var(--accent)' }} />Projects</div>
          </div>
          <div className="empty">
            <i className="ti ti-folder" />
            <div className="empty-title">No projects yet</div>
            <div className="empty-sub">Create your first project to get started</div>
            {user?.role === 'org_admin' && <button className="btn-primary" style={{ marginTop: '16px' }} onClick={onNewProject}>New Project</button>}
          </div>
        </>
      ) : (
        <div style={{ marginBottom: '16px' }}>
          <div className="section-hdr" style={{ marginBottom: '10px' }}>
            <div className="section-title">
              <i className="ti ti-folder" style={{ marginRight: '8px', color: 'var(--accent)' }} />
              Projects
              <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--color-text-tertiary)', marginLeft: '8px' }}>
                {projects.length} project{projects.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {projects.map(p => <ProjectRow key={p.id} p={p} />)}
          </div>
        </div>
      )}

      {/* Deleted-project backups — admin only */}
      {(isOrgAdmin || isSuperAdmin) && backups.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div className="section-hdr" style={{ marginBottom: 10 }}>
            <div className="section-title">
              <i className="ti ti-archive" style={{ marginRight: 8, color: 'var(--accent)' }} />
              Deleted Project Backups
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--color-text-tertiary)', marginLeft: 8 }}>
                {backups.length} backup{backups.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
          {backupsDir && (
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 8, fontFamily: 'monospace', background: 'var(--color-bg-secondary)', padding: '4px 8px', borderRadius: 4 }}>
              Stored at: {backupsDir}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {backups.map(b => (
              <div key={b.filename} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--color-bg-secondary)', borderRadius: 8, border: '1px solid var(--color-border)' }}>
                <i className="ti ti-file-zip" style={{ fontSize: 16, color: '#8b5cf6', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.filename}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {(b.size_bytes / 1024 / 1024).toFixed(2)} MB &nbsp;·&nbsp; {new Date(b.created_at).toLocaleString()}
                  </div>
                </div>
                <a
                  href={`/api/projects/backups/${encodeURIComponent(b.filename)}`}
                  download={b.filename}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 500, textDecoration: 'none' }}
                >
                  <i className="ti ti-download" style={{ fontSize: 12 }} /> Download
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
