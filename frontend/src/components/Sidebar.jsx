import { useState, useEffect, useRef, useCallback } from 'react';
import { projectDirName, collectionDirName } from '../utils/displayName';

/* ── Icon / color config per feature key ──────────────────────────────── */
const IC = {
  dashboard:             { icon: 'ti-layout-dashboard',       bg: '#dcfce7', color: '#16a34a', sub: 'Overview & metrics' },
  projects:              { icon: 'ti-folder-open',            bg: '#dbeafe', color: '#2563eb', sub: 'Manage test projects' },
  'ai-config':           { icon: 'ti-brain',                  bg: '#fef3c7', color: '#d97706', sub: 'Script generation AI' },
  settings:              { icon: 'ti-adjustments',            bg: '#f1f5f9', color: '#475569', sub: 'System configuration' },
  'settings-smtp':       { icon: 'ti-mail-cog',               bg: '#fef9c3', color: '#ca8a04', sub: 'Email config' },
  'settings-orgs':       { icon: 'ti-building',               bg: '#e0e7ff', color: '#4338ca', sub: 'Manage organizations' },
  'settings-users':      { icon: 'ti-users',                  bg: '#dbeafe', color: '#2563eb', sub: 'Users & orgs' },
  'settings-appearance': { icon: 'ti-palette',                bg: '#ede9fe', color: '#7c3aed', sub: 'Themes & display' },
  profile:               { icon: 'ti-user-circle',            bg: '#cffafe', color: '#0891b2', sub: 'My account' },
  logout:                { icon: 'ti-logout',                 bg: '#fee2e2', color: '#dc2626', sub: 'Sign out' },
  /* col step keys */
  'test-data':           { icon: 'ti-table',                  bg: '#ede9fe', color: '#7c3aed' },
  rules:                 { icon: 'ti-adjustments-horizontal', bg: '#ffedd5', color: '#ea580c' },
  config:                { icon: 'ti-settings-2',             bg: '#f1f5f9', color: '#475569' },
  'test-suites':         { icon: 'ti-test-pipe',              bg: '#e0e7ff', color: '#4338ca' },
  alerts:                { icon: 'ti-bell-ringing',           bg: '#fee2e2', color: '#dc2626' },
  runner:                { icon: 'ti-player-play',            bg: '#dcfce7', color: '#16a34a' },
  analytics:             { icon: 'ti-chart-dots-3',           bg: '#dbeafe', color: '#2563eb' },
  reports:               { icon: 'ti-chart-bar',              bg: '#e0e7ff', color: '#4338ca' },
  /* generic */
  _project:              { icon: 'ti-folder',                 bg: '#eff6ff', color: '#1d4ed8' },
  _collection:           { icon: 'ti-braces',                 bg: '#f0fdfa', color: '#0d9488' },
  _env:                  { icon: 'ti-server',                 bg: '#f0fdf4', color: '#166534' },
};

const COL_STEPS = [
  { id: 'test-data',   label: 'Test Data' },
  { id: 'rules',       label: 'Rule Engine' },
  { id: 'config',      label: 'Configuration' },
  { id: 'test-suites', label: 'Test Plans' },
  { id: 'alerts',      label: 'Alerts' },
  { id: 'runner',      label: 'Run Test' },
  { id: 'analytics',   label: 'Analytics' },
  // { id: 'reports', label: 'JMeter Report' },  // hidden — keep for future use
];

/* ── Size tiers (0=top-level … 4=deepest step) ────────────────────────── */
const SZ = [
  { iw: 40, ir: 10, ifs: 20, tfs: 14, fw: 600, gap: 10, py: 7, px: 10, showSub: true  },
  { iw: 32, ir: 8,  ifs: 16, tfs: 13, fw: 600, gap: 9,  py: 5, px: 9,  showSub: false },
  { iw: 26, ir: 7,  ifs: 13, tfs: 12, fw: 600, gap: 8,  py: 5, px: 7,  showSub: false },
  { iw: 22, ir: 6,  ifs: 12, tfs: 12, fw: 500, gap: 7,  py: 4, px: 6,  showSub: false },
  { iw: 20, ir: 5,  ifs: 11, tfs: 11, fw: 500, gap: 6,  py: 4, px: 6,  showSub: false },
];

/* ── CardBtn — universal card nav button ──────────────────────────────── */
function CardBtn({ iconKey, iconBg, iconColor, iconName, label, sub, badge, active, onClick, depth = 0, chevronOpen }) {
  const ic = IC[iconKey] || {};
  const s  = SZ[Math.min(depth, SZ.length - 1)];

  const bg  = iconBg    || ic.bg    || '#f1f5f9';
  const clr = iconColor || ic.color || '#64748b';
  const icn = iconName  || ic.icon  || 'ti-circle';
  const subtitle = sub !== undefined ? sub : ic.sub;

  return (
    <button className={`nav-card${active ? ' active' : ''}`} onClick={onClick}
      style={{ padding: `${s.py}px ${s.px}px`, gap: s.gap }}>

      {/* Colored icon box */}
      <div style={{
        width: s.iw, height: s.iw, borderRadius: s.ir,
        background: bg, color: clr,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, fontSize: s.ifs,
      }}>
        <i className={`ti ${icn}`} />
      </div>

      {/* Label + subtitle */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: s.tfs, fontWeight: s.fw, color: '#0f172a',
          lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {label}
        </div>
        {s.showSub && subtitle && (
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        )}
      </div>

      {/* Badge */}
      {badge != null && (
        <span style={{
          fontSize: 10, fontWeight: 700,
          background: active ? 'rgba(34,197,94,0.15)' : '#e2e8f0',
          color: active ? '#16a34a' : '#64748b',
          borderRadius: 12, padding: '2px 7px', flexShrink: 0,
        }}>
          {badge}
        </span>
      )}

      {/* Chevron */}
      {chevronOpen !== undefined && (
        <i className={`ti ${chevronOpen ? 'ti-chevron-up' : 'ti-chevron-down'}`}
          style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0, marginLeft: 2 }} />
      )}
    </button>
  );
}

/* ── ChildGroup — indented container with a left connector line ────────── */
function ChildGroup({ children, ml = 20, borderColor = '#e2e8f0' }) {
  return (
    <div style={{
      marginLeft: ml,
      paddingLeft: 10,
      borderLeft: `2px solid ${borderColor}`,
      marginTop: 1,
      marginBottom: 2,
    }}>
      {children}
    </div>
  );
}

/* ── Divider ─────────────────────────────────────────────────────────── */
function Divider() {
  return <div className="sidebar-divider" />;
}

/* ── CollectionItem — flat: features directly under collection ────────── */
function CollectionItem({ col, activeCollection, activeEnv, page, onSelectCollection }) {
  const [open, setOpen] = useState(false);
  const isActiveCol = activeCollection?.id === col.id;

  let envs = [];
  try { envs = JSON.parse(col.environments || '[]'); } catch {}
  if (!envs.length && col.environment) envs = [col.environment];
  if (!envs.length) envs = ['Default'];

  const firstEnv = envs[0] || null;

  // Collection header is active if we are on any of its feature pages
  const colActive = isActiveCol && (page === 'collections' || COL_STEPS.some(s => s.id === page));

  useEffect(() => { if (isActiveCol) setOpen(true); }, [isActiveCol]);

  return (
    <div>
      {/* Collection header — env names shown as subtitle */}
      <CardBtn
        iconKey="_collection"
        label={collectionDirName(col)}
        sub={envs.join(' · ')}
        active={colActive}
        depth={2}
        chevronOpen={open}
        onClick={() => { onSelectCollection(col, firstEnv, 'collections'); setOpen(o => !o); }}
      />

      {/* Feature steps directly — no env nesting */}
      {open && (
        <ChildGroup ml={18} borderColor="#d1fae5">
          {COL_STEPS.map(step => (
            <CardBtn key={step.id}
              iconKey={step.id}
              label={step.label}
              active={isActiveCol && page === step.id}
              depth={3}
              onClick={() => onSelectCollection(col, firstEnv, step.id)}
            />
          ))}
        </ChildGroup>
      )}
    </div>
  );
}

/* ── ProjectItem ─────────────────────────────────────────────────────── */
function ProjectItem({ p, isActiveProj, activeCollection, activeEnv, page, collections, onSelectProject, onSelectCollection, onAddCollection, onNav }) {
  const [open, setOpen] = useState(isActiveProj);
  useEffect(() => { if (isActiveProj) setOpen(true); }, [isActiveProj]);

  return (
    <div>
      <CardBtn
        iconKey="_project"
        label={projectDirName(p)}
        active={isActiveProj && page === 'project-home'}
        depth={1}
        chevronOpen={open}
        onClick={() => { onSelectProject(p.id); setOpen(o => !o); }}
      />

      {open && isActiveProj && (
        <ChildGroup ml={20} borderColor="#bfdbfe">
          {/* AI Configuration */}
          <CardBtn iconKey="ai-config" label="AI Configuration"
            active={page === 'ai-config'} depth={2}
            onClick={() => onNav('ai-config')} />

          {/* Git Integration */}
          <CardBtn
            iconBg="#f0fdf4" iconColor="#22c55e" iconName="ti-git-branch"
            label="Git" depth={2}
            active={page === 'git'}
            onClick={() => onNav('git')} />

          {/* Collections */}
          {collections.length === 0 && (
            <div style={{ padding: '4px 6px 4px 8px', fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
              No API sources yet
            </div>
          )}
          {collections.map(col => (
            <CollectionItem key={col.id} col={col}
              activeCollection={activeCollection} activeEnv={activeEnv}
              page={page} onSelectCollection={onSelectCollection} />
          ))}

          {/* Add API Source */}
          <button className="nav-card" onClick={onAddCollection}
            style={{ padding: '4px 7px', gap: 6, opacity: 0.75 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              background: '#f0fdf4', color: '#22c55e',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, fontSize: 12, border: '1.5px dashed #22c55e',
            }}>
              <i className="ti ti-plus" />
            </div>
            <span style={{ fontSize: 12, color: '#475569', fontWeight: 500 }}>Add API Source</span>
          </button>
        </ChildGroup>
      )}
    </div>
  );
}

/* ── Main Sidebar ────────────────────────────────────────────────────── */
export default function Sidebar({
  user, projects, activeProject, activeCollection, activeEnv,
  page, activeTab,
  onNav, onSelectProject, onSelectCollection, onNewProject, onAddCollection, onLogout,
}) {
  const initials = user?.name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const isAdmin  = user?.role === 'super_admin' || user?.role === 'org_admin';

  /* ── Resizable sidebar ──────────────────────────────────────────── */
  const MIN_W = 200, MAX_W = 520;
  const [sidebarW, setSidebarW] = useState(() => {
    const saved = localStorage.getItem('ps_sidebar_width');
    return saved ? Math.max(MIN_W, Math.min(MAX_W, Number(saved))) : 256;
  });
  const dragging = useRef(false);
  const startX   = useRef(0);
  const startW   = useRef(0);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar', `${sidebarW}px`);
    localStorage.setItem('ps_sidebar_width', String(sidebarW));
  }, [sidebarW]);

  const onMouseDown = useCallback((e) => {
    dragging.current = true;
    startX.current   = e.clientX;
    startW.current   = sidebarW;
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarW]);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const newW = Math.max(MIN_W, Math.min(MAX_W, startW.current + (e.clientX - startX.current)));
      setSidebarW(newW);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  /* Expand state */
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const collections = activeProject?.collections || [];

  /*
   * Active flags for group headers:
   * - Parent highlights ONLY when the current page belongs to it.
   * - Opening/closing a group does NOT trigger highlight by itself.
   */
  const SETTINGS_PAGES = ['settings-smtp', 'settings-users', 'settings-orgs'];
  const PROJECT_PAGES  = ['project-home', 'ai-config', 'git', 'collections',
                          'test-data', 'rules', 'config', 'test-suites',
                          'alerts', 'runner', 'analytics', 'reports'];

  const settingsActive = SETTINGS_PAGES.includes(page);
  const projectsActive = PROJECT_PAGES.includes(page);

  return (
    <div className="sidebar" style={{ width: `${sidebarW}px` }}>

      {/* Drag-resize handle */}
      <div className="sidebar-resize-handle" onMouseDown={onMouseDown}
        title="Drag to resize sidebar" />

      {/* ── Logo ─────────────────────────────────────────── */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">P</div>
        <div>
          <div className="sidebar-logo-text">Peako</div>
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>
            AI-Powered Testing
          </div>
        </div>
      </div>

      {/* ── Navigation ───────────────────────────────────── */}
      <div className="sidebar-scroll">

        {user?.role === 'super_admin' ? (
          <>
            <CardBtn iconKey="settings-orgs" label="Organizations" sub="Manage organizations"
              active={page === 'settings-orgs'} depth={0}
              onClick={() => onNav('settings-orgs')} />
            <CardBtn iconKey="settings-users" label="User Management" sub="Users & roles"
              active={page === 'settings-users'} depth={0}
              onClick={() => onNav('settings-users')} />
            <CardBtn iconKey="settings-smtp" label="SMTP Configuration" sub="Email config"
              active={page === 'settings-smtp'} depth={0}
              onClick={() => onNav('settings-smtp')} />
          </>
        ) : (
          <>
            {/* Dashboard — clicking here shows the projects overview page */}
            <CardBtn iconKey="dashboard" label="Dashboard" sub="Overview & metrics"
              active={page === 'dashboard'} depth={0}
              onClick={() => onNav('dashboard')} />

            <Divider />

            {/* Settings group header */}
            <CardBtn iconKey="settings" label="Settings" sub="System configuration"
              depth={0}
              active={settingsActive}
              chevronOpen={settingsOpen}
              onClick={() => setSettingsOpen(o => !o)} />

            {settingsOpen && (
              <ChildGroup ml={20} borderColor="#e2e8f0">
                {isAdmin && (
                  <CardBtn iconKey="settings-users" label="User Management"
                    active={page === 'settings-users'} depth={1}
                    onClick={() => onNav('settings-users')} />
                )}
                {user?.role === 'org_admin' && (
                  <CardBtn iconKey="settings-smtp" label="SMTP Configuration"
                    active={page === 'settings-smtp'} depth={1}
                    onClick={() => onNav('settings-smtp')} />
                )}
              </ChildGroup>
            )}

            <Divider />
          </>
        )}

        {/* Profile and Logout moved to banner top-right */}

      </div>


    </div>
  );
}
