import { useState, useEffect } from 'react';
import { projectDirName, collectionDirName, collectionPathLabel } from './utils/displayName';
import AcceptInvite from './pages/AcceptInvite';
import api from './api';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import CustomSelect from './components/CustomSelect';
import Modal from './components/Modal';
import ConfirmModal from './components/ConfirmModal';
import Toast from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import { useConfirm } from './hooks/useConfirm';
import { ToastProvider, useToast } from './hooks/useToast';
import Dashboard from './pages/Dashboard';
import ProjectHome from './pages/ProjectHome';
import ProjectWorkspace from './pages/ProjectWorkspace';
import Collections from './pages/Collections';
import Rules from './pages/Rules';
import Runner from './pages/Runner';
import TestSuites from './pages/TestSuites';
import TestData from './pages/TestData';
import Config from './pages/Config';
import Settings from './pages/Settings';
import Profile from './pages/Profile';
import Alerts from './pages/Alerts';
import Reports from './pages/Reports';
import Analytics from './pages/Analytics';
import GitPanel from './pages/GitPanel';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

// ── All pages that live inside the ProjectWorkspace ──
const PROJECT_PAGES = [
  'project-home','ai-config','git','collections',
  'test-data','rules','config','test-suites',
  'alerts','runner','analytics','reports',
];

// Map app page-id → browser URL
function pageToUrl(p, projectId) {
  if (p === 'dashboard')          return '/dashboard';
  if (p === 'profile')            return '/myprofile';
  if (p === 'settings-users')     return '/settings/users';
  if (p === 'settings-orgs')      return '/settings/orgs';
  if (p === 'settings-ai')        return '/settings/ai';
  if (p === 'settings-smtp')      return '/settings/smtp';
  if (projectId && (p === 'project-home' || PROJECT_PAGES.includes(p)))
    return `/projects/${projectId}`;
  return '/dashboard';
}

// Map browser URL → { page, projectId }
function urlToPageState(pathname) {
  if (pathname === '/myprofile') return { page: 'profile', projectId: null };
  const projMatch = pathname.match(/^\/projects\/(\d+)/);
  if (projMatch) return { page: 'project-home', projectId: parseInt(projMatch[1]) };
  if (pathname.startsWith('/settings')) {
    const sub = pathname.split('/')[2] || 'users';
    return { page: `settings-${sub}`, projectId: null };
  }
  return { page: 'dashboard', projectId: null };
}

const PAGE_TITLES = {
  dashboard: 'Dashboard',
  'project-home': null,
  collections: 'API Source',
  rules: 'Rule Engine',
  runner: 'Test Execution Engine',
  'test-suites': 'Test Plans',
  'test-data': 'Test Data',
  config: 'Configuration',
  'settings-users': 'User Management',
  'settings-orgs':  'Organizations',
  'settings-ai':   'AI Configuration',
  'ai-config':     'AI Configuration',
  'git':           'Git Integration',
  'settings-smtp': 'SMTP Configuration',
  profile: 'My Profile',
  reports: 'JMeter Report',
  analytics: 'Analytics',
  alerts: 'Alert Configuration',
};

const TOP_TABS = [
  { id: 'dashboard',  icon: 'ti-layout-dashboard', label: 'Dashboard' },
  { id: 'projects',   icon: 'ti-folder',            label: 'Projects' },
  { id: 'settings',   icon: 'ti-adjustments',        label: 'Settings' },
  { id: 'profile',    icon: 'ti-user',               label: 'Profile' },
];

function tabFromPage(p) {
  if (p === 'dashboard') return 'dashboard';
  if (p === 'runner') return 'projects';    // runner now lives inside collection context
  if (p.startsWith('settings')) return 'settings';
  return 'projects';
}

// Renders children only after first visit; hides (not unmounts) when inactive.
// This preserves all component state — useState, refs, timers, SSE readers — when navigating away.
function KeepAlive({ active, everVisited, children }) {
  if (!everVisited) return null;                     // not yet visited — don't mount
  // display:contents when active = wrapper is invisible to layout (no extra box).
  // display:none when inactive = entire subtree removed from painting + layout
  // but React keeps the component tree alive, preserving all useState/refs/timers.
  return <div style={{ display: active ? 'contents' : 'none' }}>{children}</div>;
}

export default function App() {
  return <ToastProvider><AppInner /></ToastProvider>;
}

function AppInner() {
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [activeCollection, setActiveCollection] = useState(null); // selected collection within project
  const [activeEnv, setActiveEnv] = useState(null);              // selected environment within collection
  const [page, setPage] = useState('dashboard');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [newProjectModal, setNewProjectModal] = useState(false);
  const [npForm, setNpForm] = useState({ name: '', description: '' });
  const [npSaving, setNpSaving] = useState(false);
  const [editProjectModal, setEditProjectModal] = useState(false);
  const [epForm, setEpForm] = useState({ id: null, name: '', description: '' });
  const [epSaving, setEpSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [collectionModalTrigger, setCollectionModalTrigger] = useState(0);
  const [ruleModalTrigger, setRuleModalTrigger] = useState(0);
  const [testSuiteModalTrigger, setTestSuiteModalTrigger] = useState(0);
  const [testDataUploadTrigger, setTestDataUploadTrigger] = useState(0);
  const [generateDataTrigger, setGenerateDataTrigger] = useState(0);
  // Single Quarks Light theme — always; clear any stale dark theme from localStorage
  useEffect(() => { localStorage.setItem('ps_theme', 'quarks'); document.documentElement.setAttribute('data-theme', 'quarks'); }, []);
  const [theme, setTheme] = useState('quarks');
  // Track which pages have been mounted at least once so KeepAlive can preserve their state.
  const [everVisited, setEverVisited] = useState(() => new Set(['dashboard']));
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const { toast } = useToast();

  function markVisited(p) {
    setEverVisited(prev => {
      if (prev.has(p)) return prev;
      const next = new Set(prev);
      next.add(p);
      return next;
    });
  }

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ps_theme', theme);
  }, [theme]);

  // Sync state when user presses browser Back / Forward
  useEffect(() => {
    const handlePop = () => {
      const { page: urlPage, projectId } = urlToPageState(window.location.pathname);
      if (projectId) {
        setProjects(prev => {
          const proj = prev.find(p => p.id === projectId);
          if (proj) { setActiveProject(proj); setPage('project-home'); setActiveTab('projects'); markVisited('project-home'); }
          return prev;
        });
      } else {
        setActiveProject(null);
        markVisited(urlPage);
        setPage(urlPage);
        setActiveTab(tabFromPage(urlPage));
      }
    };
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  useEffect(() => {
    const token      = localStorage.getItem('ps_token');
    const cachedUser = (() => { try { return JSON.parse(localStorage.getItem('ps_user')); } catch { return null; } })();

    if (!token) { setLoading(false); return; }

    if (cachedUser) {
      // User already verified this session — skip /auth/me entirely
      setUser(cachedUser);
      loadProjects(cachedUser.role);
      return;
    }

    // First load this session — call /auth/me exactly once, then cache
    api.get('/auth/me').then(({ data }) => {
      localStorage.setItem('ps_user', JSON.stringify(data.user));
      setUser(data.user);
      loadProjects(data.user.role);
    }).catch(() => {
      localStorage.removeItem('ps_token');
      localStorage.removeItem('ps_user');
      setLoading(false);
    });
  }, []);

  async function loadProjects(callerRole) {
    const { data } = await api.get('/projects');
    const ps = (data.projects || []).map(p => ({
      ...p,
      collections: p.collections || [],
      rules: p.rules || [],
    }));
    setProjects(ps);
    setLoading(false);

    const isSuperAdmin = callerRole === 'super_admin';

    // Restore state from the current browser URL (e.g. user refreshed or shared a link)
    const { page: urlPage, projectId } = urlToPageState(window.location.pathname);
    if (projectId && !isSuperAdmin) {
      const proj = ps.find(p => p.id === projectId);
      if (proj) {
        setActiveProject(proj);
        markVisited('project-home');
        setPage('project-home');
        setActiveTab('projects');
        // Fetch collections + rules for the restored project (same as selectProject())
        Promise.all([
          api.get(`/projects/${projectId}/collections`),
          api.get(`/projects/${projectId}/rules`),
        ]).then(([colsRes, rulesRes]) => {
          const enriched = {
            ...proj,
            collections: colsRes.data.collections || [],
            rules: rulesRes.data.rules || [],
          };
          setProjects(prev => prev.map(p => p.id === projectId ? enriched : p));
          setActiveProject(enriched);
        }).catch(() => {});
      } else {
        // Project not found or not accessible — reset URL to dashboard
        window.history.replaceState(null, '', '/dashboard');
      }
    } else if (urlPage && urlPage !== 'dashboard' && !isSuperAdmin) {
      markVisited(urlPage);
      setPage(urlPage);
      setActiveTab(tabFromPage(urlPage));
    } else if (isSuperAdmin && urlPage && urlPage.startsWith('settings-')) {
      // super_admin: restore settings page from URL
      markVisited(urlPage);
      setPage(urlPage);
      setActiveTab('settings');
    }
    // Redirect to default landing page after login
    if (['/', '', '/sign-in', '/dashboard'].includes(window.location.pathname) || isSuperAdmin) {
      if (isSuperAdmin) {
        const settingsUrl = urlPage && urlPage.startsWith('settings-') ? pageToUrl(urlPage) : '/settings/users';
        const settingsPage = urlPage && urlPage.startsWith('settings-') ? urlPage : 'settings-users';
        window.history.replaceState(null, '', settingsUrl);
        markVisited(settingsPage);
        setPage(settingsPage);
        setActiveTab('settings');
      } else if (['/', '', '/sign-in'].includes(window.location.pathname)) {
        window.history.replaceState(null, '', '/dashboard');
      }
    }

    return ps;
  }

  async function refreshProject() {
    const id = activeProject?.id;
    if (!id) return;
    const [projRes, cols, rules] = await Promise.all([
      api.get('/projects'),
      api.get(`/projects/${id}/collections`),
      api.get(`/projects/${id}/rules`),
    ]);
    const proj = projRes.data.projects.find(p => p.id === id);
    if (!proj) return;
    proj.collections = cols.data.collections;
    proj.rules = rules.data.rules;
    setProjects(prev => prev.map(p => p.id === id ? proj : p));
    setActiveProject(proj);
  }

  function openNewProject() { setNpForm({ name: '', description: '' }); setNewProjectModal(true); }

  function openAddCollection() {
    markVisited('collections');
    setPage('collections');
    setActiveTab('projects');
    setCollectionModalTrigger(n => n + 1);
  }


  function openEditProject(p) {
    setEpForm({ id: p.id, name: p.name, description: p.description || '' });
    setEditProjectModal(true);
  }

  async function editProject() {
    if (!epForm.name.trim()) return toast('Project name is required', 'warn');
    setEpSaving(true);
    const { data } = await api.put(`/projects/${epForm.id}`, { name: epForm.name, description: epForm.description });
    const updated = data.project;
    setProjects(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
    if (activeProject?.id === updated.id) setActiveProject(prev => ({ ...prev, ...updated }));
    setEditProjectModal(false);
    setEpSaving(false);
    toast('Project updated', 'success');
  }

  function nav(p) {
    markVisited(p);
    setPage(p);
    setActiveTab(tabFromPage(p));
    // Update browser URL
    window.history.pushState(null, '', pageToUrl(p, activeProject?.id));
    // Scroll window to top — rAF ensures it fires after KeepAlive switches
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    // Reset modal triggers so re-navigating to a page never auto-opens its form
    setCollectionModalTrigger(0);
    setRuleModalTrigger(0);
    setTestSuiteModalTrigger(0);
    setTestDataUploadTrigger(0);
    setGenerateDataTrigger(0);
  }

  function changeTab(tab) {
    setActiveTab(tab);
    let target;
    if (tab === 'dashboard')  target = 'dashboard';
    else if (tab === 'execution') target = 'runner';
    else if (tab === 'settings') {
      const isAdmin = user?.role === 'super_admin' || user?.role === 'org_admin';
      target = isAdmin ? 'settings-users' : 'settings-smtp';
    }
    else if (tab === 'projects') target = 'dashboard';
    else if (tab === 'profile')  target = 'profile';
    if (target) { markVisited(target); setPage(target); }
  }

  async function selectProject(id) {
    const p = projects.find(pr => pr.id === id) || { id };
    setActiveProject(p);
    setActiveCollection(null);
    setActiveEnv(null);
    setActiveTab('projects');
    markVisited('project-home');
    setPage('project-home');
    window.history.pushState(null, '', `/projects/${id}`);
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    // Fetch all 4 project-scoped APIs in parallel
    try {
      const [colsRes, rulesRes, suitesRes, dataRes] = await Promise.all([
        api.get(`/projects/${id}/collections`),
        api.get(`/projects/${id}/rules`),
        api.get(`/projects/${id}/test-suites`),
        api.get(`/projects/${id}/test-data`),
      ]);
      const enriched = {
        ...p,
        collections:     colsRes.data.collections   || [],
        rules:           rulesRes.data.rules          || [],
        test_plan_count: suitesRes.data.suites?.length || 0,
        test_data_count: dataRes.data.files?.length   || 0,
      };
      setProjects(prev => prev.map(pr => pr.id === id ? enriched : pr));
      setActiveProject(enriched);
    } catch {}
  }

  function selectCollection(collection, env, targetPage) {
    // Support old 2-arg calls: selectCollection(col, page)
    if (typeof env === 'string' && !targetPage && !['QA','Staging','UAT','Production','Development','Default'].includes(env)) {
      targetPage = env;
      env = null;
    }
    setActiveCollection(collection);
    setActiveEnv(env || null);
    const dest = targetPage || 'test-suites';
    markVisited(dest);
    setPage(dest);
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    setActiveTab('projects');
    setCollectionModalTrigger(0);
  }

  async function createProject() {
    if (!npForm.name.trim()) return toast('Project name is required', 'warn');
    setNpSaving(true);
    const { data } = await api.post('/projects', npForm);
    const p = data.project;
    p.collections = []; p.rules = [];
    setProjects(prev => [p, ...prev]);
    setNewProjectModal(false);
    setNpForm({ name: '', description: '' });
    setNpSaving(false);
    setActiveProject(p);
    markVisited('project-home');
    nav('project-home');
  }

  async function deleteProject(id) {
    const proj = projects.find(p => p.id === id);
    const ok = await confirm(
      `Delete "${proj?.name || 'this project'}"? All associated data will be removed. A backup ZIP will be saved to your backups folder in the background.`,
      'Delete Project'
    );
    if (!ok) return;
    try {
      await api.delete(`/projects/${id}`);
      setProjects(prev => prev.filter(p => p.id !== id));
      if (activeProject?.id === id) { setActiveProject(null); setActiveCollection(null); nav('dashboard'); }
      toast(`Project "${proj?.name}" deleted. Backup running in background.`, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to delete project', 'error');
    }
  }

  function handleLogin(u) {
    localStorage.setItem('ps_user', JSON.stringify(u)); // cache — no /auth/me needed until tab closes
    setUser(u);
    loadProjects(u.role).then(ps => {
      if (ps.length && u.role !== 'super_admin') setActiveProject(ps[0]);
    });
  }

  function logout() {
    // Revoke server-side session so the old token is immediately invalid
    api.post('/auth/logout').catch(() => {});
    localStorage.removeItem('ps_token');
    localStorage.removeItem('ps_user');
    setUser(null); setProjects([]); setActiveProject(null);
    setPage('dashboard'); setActiveTab('dashboard');
    setEverVisited(new Set(['dashboard']));
    window.history.replaceState(null, '', '/sign-in');
  }

  function renderTopbarActions() {
    switch (page) {
      case 'dashboard':
        return user?.role === 'org_admin'
          ? <button className="btn-primary" onClick={openNewProject}><i className="ti ti-plus" /> New Project</button>
          : null;
      case 'project-home':
        return activeProject ? (
          <>
            <button className="btn-secondary btn-sm" onClick={() => nav('collections')}><i className="ti ti-braces" /> API Source</button>
            <button className="btn-secondary btn-sm" onClick={() => nav('rules')}><i className="ti ti-adjustments-horizontal" /> Rules</button>
            <button className="btn-secondary btn-sm" onClick={() => nav('test-suites')}><i className="ti ti-test-pipe" /> Test Plans</button>
            <button className="btn-primary btn-sm" onClick={() => nav('runner')}><i className="ti ti-player-play" /> Run Tests</button>
          </>
        ) : null;
      case 'collections':
        return <button className="btn-primary" onClick={() => setCollectionModalTrigger(n => n + 1)}><i className="ti ti-plus" /> Add API Source</button>;
      case 'rules':
        return <button className="btn-primary" onClick={() => setRuleModalTrigger(n => n + 1)}><i className="ti ti-plus" /> Add Rule</button>;
      case 'test-suites':
        return <button className="btn-primary" onClick={() => setTestSuiteModalTrigger(n => n + 1)}><i className="ti ti-plus" /> New Test Plan</button>;
      case 'test-data':
        return (
          <>
            <button className="btn-secondary" onClick={() => setGenerateDataTrigger(n => n + 1)}><i className="ti ti-wand" /> Generate Data</button>
            <button className="btn-primary" onClick={() => setTestDataUploadTrigger(n => n + 1)}><i className="ti ti-upload" /> Upload File</button>
          </>
        );
      default:
        return null;
    }
  }

  // Pages where the user picks an env via the selector bar (not rules — that's global)
  const ENV_PAGES = new Set(['test-data', 'config', 'test-suites', 'alerts', 'runner', 'analytics', 'reports']);

  // Show ProjectWorkspace when a project is selected and page is project-related
  const collections = activeProject?.collections || [];
  const showWorkspace = !!(activeProject && PROJECT_PAGES.includes(page));

  // Derive envs list from the active collection
  const collectionEnvs = (() => {
    if (!activeCollection) return [];
    let e = [];
    try { e = JSON.parse(activeCollection.environments || '[]'); } catch {}
    if (!e.length && activeCollection.environment) e = [activeCollection.environment];
    if (!e.length) e = ['Default'];
    return e;
  })();

  const pageTitle = page === 'project-home'
    ? (projectDirName(activeProject) || 'Project')
    : page === 'runner' && activeCollection && activeEnv
      ? `Run Tests — ${collectionDirName(activeCollection)} / ${activeEnv}`
      : (PAGE_TITLES[page] || page);
  const sharedProps = { onNav: nav, onProjectUpdated: refreshProject, collection: activeCollection, env: activeEnv, envs: collectionEnvs, onEnvChange: setActiveEnv };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--color-body, #1e1f22)' }}>
      <div style={{ color: 'var(--color-text-primary, #bcbec4)', fontSize: '15px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <span className="spinner" /> Loading Peako...
      </div>
    </div>
  );

  // Handle invite token in URL (e.g. /accept-invite/abc123)
  const inviteMatch = window.location.pathname.match(/^\/accept-invite\/([a-f0-9]{32,128})$/i);
  if (inviteMatch && !user) {
    return <AcceptInvite token={inviteMatch[1]} onLogin={handleLogin} />;
  }

  // Forgot password page
  if (window.location.pathname === '/forgot-password') {
    return <ForgotPassword />;
  }

  // Reset password page (e.g. /reset-password/abc123)
  const resetMatch = window.location.pathname.match(/^\/reset-password\/([a-f0-9]{32,128})$/i);
  if (resetMatch) {
    return <ResetPassword token={resetMatch[1]} />;
  }

  if (!user) {
    // Ensure URL shows /sign-in while on the login screen
    if (!['/sign-in', '/forgot-password'].includes(window.location.pathname) &&
        !window.location.pathname.startsWith('/reset-password') &&
        !window.location.pathname.startsWith('/accept-invite')) {
      window.history.replaceState(null, '', '/sign-in');
    }
    return <Auth onLogin={handleLogin} />;
  }

  // ── Project Workspace — replaces entire layout (banner + sidebar + content) ──
  if (showWorkspace) {
    return (
      <>
      <Toast />
      <ProjectWorkspace
        key={activeProject.id}
        project={{ ...activeProject, collections }}
        user={user}
        projects={projects}
        onBack={() => { setActiveProject(null); setPage('dashboard'); window.history.pushState(null, '', '/dashboard'); window.scrollTo({ top: 0, behavior: 'instant' }); }}
        onProjectUpdated={refreshProject}
        theme={theme}
        onThemeChange={setTheme}
      />
      </>
    );
  }

  return (
    <div>
      {/* Banner */}
      <div className="app-banner">
        {/* Left: Quarks logo + subtitle — left aligned */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img
            src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
            alt="QTSolv"
            style={{ height: '30px', width: 'auto', objectFit: 'contain', flexShrink: 0 }}
          />
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontWeight: 500, letterSpacing: '.3px' }}>
            AI-Powered Performance Test Studio
          </span>
        </div>

        {/* Right: Profile + Logout */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="banner-action-btn" onClick={() => nav('profile')}>
            <i className="ti ti-user-circle" style={{ fontSize: 14 }} />
            {user?.name || 'Profile'}
          </button>
          <button className="banner-action-btn" onClick={logout}
            style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5' }}>
            <i className="ti ti-logout" style={{ fontSize: 14 }} />
            Logout
          </button>
        </div>
      </div>

      {/* Sidebar only for org_admin and super_admin — regular users go straight to dashboard */}
      {user?.role !== 'user' && (
        <Sidebar
          user={user}
          projects={projects}
          activeProject={activeProject}
          activeCollection={activeCollection}
          activeEnv={activeEnv}
          page={page}
          activeTab={activeTab}
          onNav={nav}
          onSelectProject={selectProject}
          onSelectCollection={selectCollection}
          onNewProject={openNewProject}
          onAddCollection={openAddCollection}
          onLogout={logout}
          onTabChange={changeTab}
        />
      )}

      {/* Main content area — no left margin for regular users (no sidebar) */}
      <div className={`main${user?.role === 'user' ? ' no-topbar' : ''}`}
        style={user?.role === 'user' ? { marginLeft: 0, width: '100%' } : {}}>
        {/* Topbar only for admin roles */}
        {user?.role !== 'user' && (
          <div className="topbar" style={user?.role === 'user' ? { left: 0 } : {}}>
            <div className="topbar-title">{pageTitle}</div>
            <div className="topbar-actions">{renderTopbarActions()}</div>
          </div>
        )}

        {user?.role !== 'super_admin' && (
          <KeepAlive active={page === 'dashboard'} everVisited={everVisited.has('dashboard')}>
            <Dashboard projects={projects} user={user} onSelectProject={selectProject}
              onDeleteProject={user?.role === 'org_admin' ? deleteProject : undefined}
              onNewProject={user?.role === 'org_admin' ? openNewProject : undefined}
              onEditProject={user?.role === 'org_admin' ? openEditProject : undefined} />
          </KeepAlive>
        )}

        {/* Settings only for admin roles */}
        {user?.role !== 'user' && (
          <KeepAlive active={page.startsWith('settings')} everVisited={[...everVisited].some(p => p.startsWith('settings'))}>
            <Settings page={page} theme={theme} onThemeChange={setTheme} user={user} projects={projects} />
          </KeepAlive>
        )}
        {/* NOTE: all project-related pages (project-home, collections, rules, etc.)
             are now handled inside ProjectWorkspace which renders as a full-screen root.
             Only dashboard, settings, profile remain here. */}
        <KeepAlive active={page === 'profile'} everVisited={everVisited.has('profile')}>
          <Profile user={user} onUserUpdated={u => { setUser(u); localStorage.setItem('ps_user', JSON.stringify(u)); }} onBack={() => nav('dashboard')} />
        </KeepAlive>

      </div>

      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      <Toast />

      {editProjectModal && (
        <Modal onClose={() => setEditProjectModal(false)}>
          <div className="modal-hdr">
            <div className="modal-title">Edit Project</div>
            <button className="btn-icon" onClick={() => setEditProjectModal(false)}><i className="ti ti-x" /></button>
          </div>
          <div className="form-group">
            <label className="form-label">Project Name</label>
            <input type="text" value={epForm.name} onChange={e => setEpForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Checkout API Suite" autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input type="text" value={epForm.description} onChange={e => setEpForm(f => ({ ...f, description: e.target.value }))} placeholder="What are you testing?" />
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setEditProjectModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={editProject} disabled={epSaving}>{epSaving && <span className="spinner" />}Save Changes</button>
          </div>
        </Modal>
      )}

      {newProjectModal && (
        <Modal onClose={() => setNewProjectModal(false)}>
          <div className="modal-hdr">
            <div className="modal-title">New Project</div>
            <button className="btn-icon" onClick={() => setNewProjectModal(false)}><i className="ti ti-x" /></button>
          </div>
          <div className="form-group">
            <label className="form-label">Project Name</label>
            <input type="text" value={npForm.name} onChange={e => setNpForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Checkout API Suite" autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input type="text" value={npForm.description} onChange={e => setNpForm(f => ({ ...f, description: e.target.value }))} placeholder="What are you testing?" />
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setNewProjectModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={createProject} disabled={npSaving}>{npSaving && <span className="spinner" />}Create Project</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
