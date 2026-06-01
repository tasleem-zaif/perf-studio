import { useState } from 'react';
import { projectDirName } from '../utils/displayName';

export default function Dashboard({ projects, user, onSelectProject, onDeleteProject, onNewProject, onEditProject }) {
  const isSuperAdmin = user?.role === 'super_admin';
  const isOrgAdmin   = user?.role === 'org_admin';

  const totalCollections = projects.reduce((a, p) => a + (p.collections?.length || 0), 0);
  const totalRules       = projects.reduce((a, p) => a + (p.rules?.length || 0), 0);

  const orgCount = isSuperAdmin
    ? [...new Set(projects.map(p => p.org_name).filter(Boolean))].length
    : null;

  function ProjectRow({ p }) {
    return (
      <div
        onClick={() => onSelectProject(p.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: '14px',
          padding: '11px 16px',
          background: 'var(--color-background-primary)',
          border: '1px solid var(--color-border-secondary)',
          borderRadius: '8px',
          cursor: 'pointer',
          transition: 'background .12s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--color-background-hover)'}
        onMouseLeave={e => e.currentTarget.style.background = 'var(--color-background-primary)'}
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
          <i className="ti ti-braces" style={{ fontSize: '11px' }} /> {p.collections?.length || 0} API sources
        </span>

        {/* Rules */}
        <span className="tag tag-gray" style={{ flexShrink: 0 }}>
          <i className="ti ti-adjustments-horizontal" style={{ fontSize: '11px' }} /> {p.rules?.length || 0} rules
        </span>

        {/* Created date */}
        <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', flexShrink: 0, minWidth: '82px' }}>
          Created {p.created_at?.slice(0, 10)}
        </div>

        {/* Edit */}
        <button
          className="btn-secondary btn-sm"
          style={{ flexShrink: 0 }}
          onClick={e => { e.stopPropagation(); onEditProject(p); }}
        >
          <i className="ti ti-pencil" />
        </button>

        {/* Delete */}
        <button
          className="btn-secondary btn-sm"
          style={{ color: 'var(--danger)', borderColor: 'rgba(247,84,100,0.3)', flexShrink: 0 }}
          onClick={e => { e.stopPropagation(); onDeleteProject(p.id); }}
        >
          <i className="ti ti-trash" />
        </button>
      </div>
    );
  }


  return (
    <div className="page fade-in">
      {/* Top stats */}
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
          <div className="stat-val">{projects.length}</div>
          <div className="stat-sub">{isSuperAdmin ? 'All organizations' : isOrgAdmin ? 'Your organization' : 'Active'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><i className="ti ti-braces" style={{ marginRight: '4px' }} />API Sources</div>
          <div className="stat-val">{totalCollections}</div>
          <div className="stat-sub">Across all projects</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><i className="ti ti-adjustments-horizontal" style={{ marginRight: '4px' }} />Rules</div>
          <div className="stat-val">{totalRules}</div>
          <div className="stat-sub">Performance configs</div>
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
            {!isSuperAdmin && <button className="btn-primary" style={{ marginTop: '16px' }} onClick={onNewProject}>New Project</button>}
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
    </div>
  );
}
