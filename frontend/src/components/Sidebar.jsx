import { useState, useEffect, useRef, useCallback } from 'react';
import { projectDirName, collectionDirName } from '../utils/displayName';

/* ── Shared atoms ─────────────────────────────────────────────────────────── */

/** Top-level expandable group (Dashboard, Projects, Execution…) */
function NavGroup({ icon, label, children, badge, defaultOpen = false, forceOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);

  return (
    <div>
      {/* Header row */}
      <div
        className="nav-item"
        onClick={() => setOpen(o => !o)}
        style={{ fontWeight: 600 }}
      >
        <i className={`ti ${icon}`} style={{ fontSize: '17px', flexShrink: 0 }} />
        <span style={{ flex: 1, wordBreak: 'break-word' }}>
          {label}
        </span>
        {badge != null && (
          <span style={{
            fontSize: '10px', fontWeight: 700, flexShrink: 0,
            background: 'rgba(0,0,0,0.20)', color: '#fff',
            borderRadius: '10px', padding: '1px 6px',
          }}>
            {badge}
          </span>
        )}
        <i
          className={`ti ${open ? 'ti-chevron-up' : 'ti-chevron-down'}`}
          style={{ fontSize: '12px', flexShrink: 0, opacity: 0.7 }}
        />
      </div>

      {/* Children — indented with vertical connector line */}
      {open && (
        <div style={{ position: 'relative' }}>
          {/* Vertical connector line */}
          <div style={{
            position: 'absolute', left: '26px', top: 0, bottom: 0,
            width: '1px', background: 'rgba(255,255,255,0.20)',
            pointerEvents: 'none',
          }} />
          {children}
        </div>
      )}
    </div>
  );
}

/** Leaf item with bullet dot on the connector line */
function NavLeaf({ icon, label, active, onClick, depth = 1 }) {
  const leftPad = 14 + depth * 18;
  return (
    <button
      className={`nav-step${active ? ' active' : ''}`}
      onClick={onClick}
      style={{ paddingLeft: `${leftPad}px`, position: 'relative' }}
    >
      {/* Bullet on the line */}
      <span style={{
        position: 'absolute', left: '23px', top: '50%', transform: 'translateY(-50%)',
        width: '7px', height: '7px', borderRadius: '50%',
        background: active ? '#fff' : 'rgba(255,255,255,0.45)',
        flexShrink: 0,
      }} />
      {icon
        ? <i className={`ti ${icon}`} style={{ fontSize: '14px', flexShrink: 0 }} />
        : <span style={{ width: '14px', flexShrink: 0 }} />
      }
      <span style={{ wordBreak: 'break-word' }}>
        {label}
      </span>
    </button>
  );
}

/** Section divider label */
function Divider() {
  return <div style={{ height: '1px', background: 'rgba(255,255,255,0.12)', margin: '4px 0' }} />;
}

/* ── Constants ─────────────────────────────────────────────────────────────── */

const COL_STEPS = [
  { id: 'test-data',   icon: 'ti-table',                  label: 'Test Data' },
  { id: 'rules',       icon: 'ti-adjustments-horizontal', label: 'Rule Engine' },
  { id: 'config',      icon: 'ti-settings-2',             label: 'Configuration' },
  { id: 'test-suites', icon: 'ti-test-pipe',              label: 'Test Plans' },
  { id: 'alerts',      icon: 'ti-bell-ringing',           label: 'Alerts' },
  { id: 'runner',      icon: 'ti-player-play',            label: 'Run Test' },
  { id: 'analytics',   icon: 'ti-chart-dots-3',           label: 'Analytics' },
  { id: 'reports',     icon: 'ti-chart-bar',              label: 'JMeter Report' },
];

/* ── Collection item with per-env sub-trees ─────────────────────────────── */

function CollectionItem({ col, activeCollection, activeEnv, page, onSelectCollection, isColOpen, toggleCol }) {
  const [open, setOpen] = useState(false);
  const [expandedEnvs, setExpandedEnvs] = useState({});

  const isActiveCol = activeCollection?.id === col.id;
  const isEnvOpen   = env => expandedEnvs[env] !== false;
  const toggleEnv   = env => setExpandedEnvs(p => ({ ...p, [env]: !isEnvOpen(env) }));

  // Parse environments array (support both new multi-env and legacy single-env)
  let envs = [];
  try { envs = JSON.parse(col.environments || '[]'); } catch {}
  if (!envs.length && col.environment) envs = [col.environment];
  if (!envs.length) envs = ['Default'];

  useEffect(() => { if (isActiveCol) setOpen(true); }, [isActiveCol]);

  return (
    <div>
      {/* Collection header — click: navigate to detail + toggle */}
      <button
        className={`nav-step${isActiveCol && page === 'collections' ? ' active' : ''}`}
        onClick={() => { onSelectCollection(col, null, 'collections'); setOpen(o => !o); }}
        style={{ width: '100%', paddingLeft: '44px', fontWeight: 600, justifyContent: 'space-between', position: 'relative' }}
      >
        <span style={{
          position: 'absolute', left: '23px',
          width: '7px', height: '7px', borderRadius: '50%',
          background: isActiveCol ? '#fff' : 'rgba(255,255,255,0.40)',
        }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
          <i className="ti ti-braces" style={{ fontSize: '13px', flexShrink: 0 }} />
          <span style={{ wordBreak: 'break-word' }}>{collectionDirName(col)}</span>
        </span>
        <i className={`ti ${open ? 'ti-chevron-up' : 'ti-chevron-down'}`}
          style={{ fontSize: '11px', flexShrink: 0, opacity: 0.7, marginLeft: '6px' }} />
      </button>

      {/* Environments */}
      {open && envs.map(env => {
        const isActiveEnv = isActiveCol && activeEnv === env;
        const envOpen = isEnvOpen(env);
        return (
          <div key={env}>
            {/* Env row — click: expand/collapse ONLY (no navigation) */}
            <button
              className={`nav-step${isActiveEnv ? ' active' : ''}`}
              onClick={() => toggleEnv(env)}
              style={{ width: '100%', paddingLeft: '60px', fontWeight: 600, justifyContent: 'space-between', position: 'relative' }}
            >
              <span style={{
                position: 'absolute', left: '39px', top: '50%', transform: 'translateY(-50%)',
                width: '6px', height: '6px', borderRadius: '50%',
                background: isActiveEnv ? '#fff' : 'rgba(255,255,255,0.35)',
              }} />
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
                <i className="ti ti-server" style={{ fontSize: '12px', flexShrink: 0 }} />
                <span style={{ wordBreak: 'break-word' }}>{env}</span>
              </span>
              <i className={`ti ${envOpen ? 'ti-chevron-up' : 'ti-chevron-down'}`}
                style={{ fontSize: '10px', flexShrink: 0, opacity: 0.6, marginLeft: '4px' }} />
            </button>

            {/* Sub-items per env */}
            {envOpen && (
              <div style={{ position: 'relative' }}>
                <div style={{
                  position: 'absolute', left: '56px', top: 0, bottom: 0,
                  width: '1px', background: 'rgba(255,255,255,0.15)',
                }} />
                {COL_STEPS.map(step => (
                  <button
                    key={step.id}
                    className={`nav-step${isActiveEnv && page === step.id ? ' active' : ''}`}
                    onClick={() => onSelectCollection(col, env, step.id)}
                    style={{ paddingLeft: '78px', position: 'relative' }}
                  >
                    <span style={{
                      position: 'absolute', left: '53px', top: '50%', transform: 'translateY(-50%)',
                      width: '5px', height: '5px', borderRadius: '50%',
                      background: (isActiveEnv && page === step.id) ? '#fff' : 'rgba(255,255,255,0.30)',
                    }} />
                    <i className={`ti ${step.icon}`} style={{ fontSize: '13px', flexShrink: 0 }} />
                    {step.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Project item ────────────────────────────────────────────────────────── */

function ProjectItem({
  p, isActiveProj, activeCollection, activeEnv, page, collections,
  onSelectProject, onSelectCollection, onAddCollection, onNav,
}) {
  const [open, setOpen] = useState(isActiveProj);

  useEffect(() => { if (isActiveProj) setOpen(true); }, [isActiveProj]);

  return (
    <div>
      {/* Project row */}
      <button
        className={`nav-step${isActiveProj && page === 'project-home' ? ' active' : ''}`}
        onClick={() => { onSelectProject(p.id); setOpen(o => !o); }}
        style={{ width: '100%', paddingLeft: '32px', fontWeight: 600, justifyContent: 'space-between', position: 'relative' }}
      >
        <span style={{
          position: 'absolute', left: '23px',
          width: '7px', height: '7px', borderRadius: '50%',
          background: isActiveProj ? '#fff' : 'rgba(255,255,255,0.40)',
        }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
          <i className="ti ti-folder" style={{ fontSize: '14px', flexShrink: 0 }} />
          <span style={{ wordBreak: 'break-word' }}>{projectDirName(p)}</span>
        </span>
        <i className={`ti ${open ? 'ti-chevron-up' : 'ti-chevron-down'}`}
          style={{ fontSize: '11px', flexShrink: 0, opacity: 0.7, marginLeft: '6px' }} />
      </button>

      {open && isActiveProj && (
        <>
          {/* AI Configuration */}
          <NavLeaf icon="ti-brain" label="AI Configuration"
            active={page === 'ai-config'} onClick={() => onNav('ai-config')} depth={2} />

          {/* Collections — each with its env sub-trees */}
          {collections.length === 0 && (
            <div style={{ padding: '6px 14px 6px 44px', fontSize: '13px', color: '#fff', fontStyle: 'italic' }}>
              No API sources yet
            </div>
          )}
          {collections.map(col => (
            <CollectionItem
              key={col.id}
              col={col}
              activeCollection={activeCollection}
              activeEnv={activeEnv}
              page={page}
              onSelectCollection={onSelectCollection}
            />
          ))}

          <button className="nav-item" onClick={onAddCollection}
            style={{ paddingLeft: '44px', fontSize: '13px', fontWeight: 500, color: '#fff' }}>
            <i className="ti ti-plus" style={{ fontSize: '14px' }} /> Add API Source
          </button>
        </>
      )}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */

export default function Sidebar({
  user, projects, activeProject, activeCollection, activeEnv,
  page, activeTab,
  onNav, onSelectProject, onSelectCollection, onNewProject, onAddCollection, onLogout,
}) {
  const initials = user?.name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const isAdmin  = user?.role === 'super_admin' || user?.role === 'org_admin';

  // ── Resizable sidebar ────────────────────────────────────────────────────
  const MIN_W = 200;
  const MAX_W = 520;
  const [sidebarW, setSidebarW] = useState(() => {
    const saved = localStorage.getItem('ps_sidebar_width');
    return saved ? Math.max(MIN_W, Math.min(MAX_W, Number(saved))) : 248;
  });
  const dragging = useRef(false);
  const startX   = useRef(0);
  const startW   = useRef(0);

  // Sync width to CSS variable so `.main` margin updates too
  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar', `${sidebarW}px`);
    localStorage.setItem('ps_sidebar_width', String(sidebarW));
  }, [sidebarW]);

  const onMouseDown = useCallback((e) => {
    dragging.current = true;
    startX.current   = e.clientX;
    startW.current   = sidebarW;
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarW]);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newW  = Math.max(MIN_W, Math.min(MAX_W, startW.current + delta));
      setSidebarW(newW);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor    = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const collections = activeProject?.collections || [];

  return (
    <div className="sidebar" style={{ width: `${sidebarW}px` }}>
      {/* Drag-resize handle */}
      <div
        onMouseDown={onMouseDown}
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: '5px',
          cursor: 'col-resize', zIndex: 20,
          background: 'transparent',
          transition: 'background .15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.20)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        title="Drag to resize sidebar"
      />

      {/* ── Logo ─────────────────────────────────────────── */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">P</div>
        <div>
          <div className="sidebar-logo-text">Performance Studio</div>
          <div style={{ fontSize: '10px', color: '#fff', marginTop: '1px' }}>
            AI-Powered Performance Testing
          </div>
        </div>
      </div>

      {/* ── Nav tree ─────────────────────────────────────── */}
      <div className="sidebar-scroll" style={{ paddingBottom: '8px' }}>

        {/* Dashboard */}
        <button className={`nav-item${page === 'dashboard' ? ' active' : ''}`}
          onClick={() => onNav('dashboard')} style={{ fontWeight: 600 }}>
          <i className="ti ti-layout-dashboard" />
          Dashboard
        </button>

        <Divider />

        {/* Projects */}
        <NavGroup icon="ti-folder" label="Projects" badge={projects.length} defaultOpen={true}>
          {projects.map(p => (
            <ProjectItem
              key={p.id}
              p={p}
              isActiveProj={activeProject?.id === p.id}
              activeCollection={activeCollection}
              activeEnv={activeEnv}
              page={page}
              collections={activeProject?.id === p.id ? collections : []}
              onSelectProject={onSelectProject}
              onSelectCollection={onSelectCollection}
              onAddCollection={onAddCollection}
              onNav={onNav}
            />
          ))}
          {/* New Project */}
          <button className="nav-item" onClick={onNewProject}
            style={{ paddingLeft: '32px', fontSize: '12.5px', fontWeight: 500, color: '#fff' }}>
            <i className="ti ti-plus" style={{ fontSize: '14px' }} /> New Project
          </button>
        </NavGroup>

        <Divider />

        <Divider />

        {/* Settings */}
        <NavGroup icon="ti-adjustments" label="Settings" defaultOpen={false}>
          {isAdmin && (
            <NavLeaf icon="ti-users" label="User Management"
              active={page === 'settings-users'} onClick={() => onNav('settings-users')} />
          )}
          <NavLeaf icon="ti-palette" label="Appearance"
            active={page === 'settings-appearance'} onClick={() => onNav('settings-appearance')} />
        </NavGroup>

        <Divider />

        {/* Profile */}
        <button className={`nav-item${page === 'profile' ? ' active' : ''}`}
          onClick={() => onNav('profile')} style={{ fontWeight: 600 }}>
          <i className="ti ti-user" />
          My Profile
        </button>

        {/* Logout */}
        <button className="nav-item" onClick={onLogout}
          style={{ fontWeight: 600, color: '#fff' }}>
          <i className="ti ti-logout" />
          Logout
        </button>

      </div>

      {/* ── Footer ─────────────────────────────────────────── */}
      <div className="sidebar-footer">
        <div className="user-pill">
          <div className="avatar">{initials}</div>
          <div style={{ overflow: 'hidden' }}>
            <div className="user-name">{user?.name}</div>
            <div className="user-role">
              {user?.org_name || (user?.role === 'super_admin' ? 'Super Admin' : user?.email)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
