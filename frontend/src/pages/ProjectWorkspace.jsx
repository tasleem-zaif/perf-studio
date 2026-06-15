import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';
import Settings    from './Settings';
import GitPanel    from './GitPanel';
import Collections from './Collections';
import TestData    from './TestData';
import Rules       from './Rules';
import Config      from './Config';
import TestSuites  from './TestSuites';
import Alerts      from './Alerts';
import Runner      from './Runner';
import Analytics      from './Analytics';
import Reports        from './Reports';
import PipelineConfig from './PipelineConfig';

const NAV_ITEMS = [
  { id: 'overview',    icon: 'ti-layout-dashboard',       label: 'Overview',       sub: 'Project summary',              color: '#22c55e', bg: '#dcfce7' },
  { id: 'collections', icon: 'ti-braces',                 label: 'API Sources',    sub: 'Import API endpoints',         color: '#0d9488', bg: '#f0fdfa' },
  { id: 'config',      icon: 'ti-settings-2',             label: 'Configuration',  sub: 'Environment, AI & Pipeline',   color: '#475569', bg: '#f1f5f9' },
  { id: 'test-data',   icon: 'ti-table',                  label: 'Test Data',      sub: 'CSV datasets per env',         color: '#7c3aed', bg: '#ede9fe' },
  { id: 'rules',       icon: 'ti-adjustments-horizontal', label: 'Rule Engine',    sub: 'Performance thresholds',       color: '#ea580c', bg: '#ffedd5' },
  { id: 'test-suites', icon: 'ti-test-pipe',              label: 'Test Plans',     sub: 'Create & generate scripts',    color: '#4338ca', bg: '#e0e7ff' },
  { id: 'alerts',      icon: 'ti-bell-ringing',           label: 'Alerts',         sub: 'Email notifications',          color: '#dc2626', bg: '#fee2e2' },
  { id: 'runner',      icon: 'ti-player-play',            label: 'Run Test',       sub: 'Execute load tests',           color: '#16a34a', bg: '#dcfce7' },
  { id: 'analytics',   icon: 'ti-chart-dots-3',           label: 'Analytics',      sub: 'Performance dashboards',       color: '#2563eb', bg: '#dbeafe' },
  // { id: 'reports', icon: 'ti-chart-bar', label: 'JMeter Report', sub: 'HTML test reports', color: '#4338ca', bg: '#e0e7ff' },  // hidden — keep for future use
];

const QUICK_ACCESS = [
  { id: 'collections', icon: 'ti-braces',            label: 'API Sources',        desc: 'Import Postman, Swagger or cURL to define your endpoints.',  color: '#0d9488', bg: '#f0fdfa' },
  { id: 'config',      icon: 'ti-settings-2',        label: 'Configuration',      desc: 'Set up environment, AI provider and Git integration.',        color: '#475569', bg: '#f1f5f9' },
  { id: 'test-data',   icon: 'ti-table',             label: 'Test Data',          desc: 'Upload CSV datasets for parameterized load testing.',         color: '#7c3aed', bg: '#ede9fe' },
  { id: 'rules',       icon: 'ti-adjustments-horizontal', label: 'Rule Engine',   desc: 'Define response time, error rate and throughput thresholds.', color: '#ea580c', bg: '#ffedd5' },
  { id: 'test-suites', icon: 'ti-test-pipe',         label: 'Test Plans',         desc: 'Create test plans and generate JMeter/K6 scripts with AI.',   color: '#4338ca', bg: '#e0e7ff' },
  { id: 'runner',      icon: 'ti-player-play',       label: 'Run Test',           desc: 'Execute load tests and stream live logs.',                    color: '#16a34a', bg: '#dcfce7' },
  { id: 'analytics',   icon: 'ti-chart-dots-3',      label: 'Analytics',          desc: 'Live dashboards for response time, throughput and errors.',   color: '#2563eb', bg: '#dbeafe' },
  // { id: 'reports', icon: 'ti-chart-bar', label: 'JMeter Report', desc: 'Full HTML test report with APDEX, percentiles and errors.', color: '#4338ca', bg: '#e0e7ff' },  // hidden
];

// Action button config per page
const PAGE_ACTIONS = {
  collections:  [{ label: 'Add API Source', icon: 'ti-plus',   color: '#22c55e' }],
  rules:        [{ label: 'Add Rule',        icon: 'ti-plus',   color: '#22c55e' }],
  'test-data':  [
    { label: 'Generate Test Data', icon: 'ti-wand',   color: '#22c55e', key: 'generate' },
    { label: 'Upload Test Data',              icon: 'ti-upload', color: '#22c55e', key: 'upload'   },
  ],
  'test-suites':[ { label: 'Add Test Plan', icon: 'ti-plus',   color: '#22c55e' }],
};

export default function ProjectWorkspace({ project, user, projects, onBack, onProjectUpdated, theme, onThemeChange }) {
  const [activePage,            setActivePage]            = useState(() => {
    // Restore section from URL e.g. /projects/5/test-suites → 'test-suites'
    const m = window.location.pathname.match(/^\/projects\/\d+\/(.+)$/);
    return m ? m[1] : 'overview';
  });
  const [activeCollection,      setActiveCollection]      = useState(null);
  const [activeEnv,             setActiveEnv]             = useState(null);
  const [hasJmeterPlan,         setHasJmeterPlan]         = useState(false);
  const [testPlanCount,         setTestPlanCount]         = useState(project?.test_plan_count || 0);
  const [testDataCount,         setTestDataCount]         = useState(project?.test_data_count || 0);
  const [collectionsModalTrig,  setCollectionsModalTrig]  = useState(0);
  const [rulesModalTrig,        setRulesModalTrig]        = useState(0);
  const [testDataUploadTrig,    setTestDataUploadTrig]    = useState(0);
  const [testDataGenerateTrig,  setTestDataGenerateTrig]  = useState(0);
  const [testSuitesModalTrig,   setTestSuitesModalTrig]   = useState(0);
  const [configTab,             setConfigTab]             = useState('environment'); // 'environment' | 'ai' | 'pipeline'
  const [gitDrawerOpen,         setGitDrawerOpen]         = useState(false);
  const [gitDrawerKey,          setGitDrawerKey]          = useState(0);
  const [drawerWidth,           setDrawerWidth]           = useState(700);
  const isResizing   = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(700);

  const onResizeMove = useCallback((e) => {
    if (!isResizing.current) return;
    const delta    = e.clientX - resizeStartX.current;
    const newWidth = Math.min(Math.max(resizeStartW.current + delta, 360), window.innerWidth - 320);
    setDrawerWidth(newWidth);
  }, []);

  const onResizeEnd = useCallback(() => {
    if (!isResizing.current) return;
    isResizing.current = false;
    document.body.style.userSelect   = '';
    document.body.style.cursor       = '';
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup',   onResizeEnd);
  }, [onResizeMove]);

  const onResizeStart = useCallback((e) => {
    e.preventDefault();
    isResizing.current  = true;
    resizeStartX.current = e.clientX;
    resizeStartW.current = drawerWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor     = 'col-resize';
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup',   onResizeEnd);
  }, [drawerWidth, onResizeMove, onResizeEnd]);

  const collections = project?.collections || [];
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin';

  // Fetch all 4 project-scoped stats in parallel on project open
  useEffect(() => {
    if (!project?.id) return;
    Promise.all([
      api.get(`/projects/${project.id}/collections`),
      api.get(`/projects/${project.id}/rules`),
      api.get(`/projects/${project.id}/test-suites`),
      api.get(`/projects/${project.id}/test-data`),
    ]).then(([colsRes, , suitesRes, dataRes]) => {
      const suites = suitesRes.data.suites || [];
      setHasJmeterPlan(suites.some(s => s.engine === 'jmeter'));
      setTestPlanCount(suites.length);
      setTestDataCount(dataRes.data.files?.length || 0);
    }).catch(() => {});
  }, [project?.id]);

  useEffect(() => {
    if (collections.length > 0 && !activeCollection) {
      const col = collections[0];
      setActiveCollection(col);
      let envs = [];
      try { envs = JSON.parse(col.environments || '[]'); } catch {}
      if (!envs.length && col.environment) envs = [col.environment];
      if (envs.length) setActiveEnv(envs[0]);
    }
  }, [project?.id]);

  const collectionEnvs = (() => {
    if (!activeCollection) return [];
    let e = [];
    try { e = JSON.parse(activeCollection.environments || '[]'); } catch {}
    if (!e.length && activeCollection.environment) e = [activeCollection.environment];
    if (!e.length) e = ['Default'];
    return e;
  })();

  function navigate(pageId) {
    setActivePage(pageId);
    // Update browser URL — overview → /projects/:id, section → /projects/:id/section
    const section = pageId === 'overview' ? '' : `/${pageId}`;
    window.history.pushState(null, '', `/projects/${project.id}${section}`);
    const el = document.getElementById('ws-scroll');
    if (el) el.scrollTop = 0;
  }

  function refreshJmeterCheck() {
    if (!project?.id) return;
    api.get(`/projects/${project.id}/test-suites`)
      .then(({ data }) => {
        const suites = data.suites || [];
        setHasJmeterPlan(suites.some(s => s.engine === 'jmeter'));
        setTestPlanCount(suites.length);
      })
      .catch(() => {});
  }

  const shared = { project, collection: activeCollection, env: activeEnv, envs: collectionEnvs, onEnvChange: setActiveEnv, onNav: navigate, onProjectUpdated };
  const stats = [
    { label: 'API SOURCES', value: collections.length,        color: '#22c55e', iconBg: '#dcfce7', icon: 'ti-braces',                link: 'collections' },
    { label: 'RULES',       value: project?.rules?.length || 0, color: '#3b82f6', iconBg: '#dbeafe', icon: 'ti-adjustments-horizontal', link: 'rules' },
    { label: 'TEST PLANS',  value: testPlanCount,              color: '#f59e0b', iconBg: '#fef3c7', icon: 'ti-test-pipe',              link: 'test-suites' },
    { label: 'TEST DATA',   value: testDataCount,              color: '#a78bfa', iconBg: '#ede9fe', icon: 'ti-table',                  link: 'test-data' },
  ];

  // Pages that require git to be initialized (folder_path must exist)
  const GIT_REQUIRED_PAGES = ['test-suites', 'test-data', 'runner', 'analytics', 'reports'];
  const gitNotInitialized = !project?.git_initialized && !project?.folder_path;
  const initialized = !!(project?.git_initialized || project?.folder_path);

  function GitNotInitializedBanner() {
    return (
      <div style={{ margin: '20px 24px', padding: '16px 20px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <i className="ti ti-git-branch" style={{ color: '#b45309', fontSize: 20, flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#b45309', marginBottom: 4 }}>
              Git Repository Not Initialized
            </div>
            <div style={{ fontSize: 13, color: '#92400e', lineHeight: 1.6 }}>
              You need to initialize the Git repository before using this feature.
              <br />Scripts, test data and test runs are stored inside the git workspace.
            </div>
            <button onClick={() => { navigate('config'); setConfigTab('git'); }}
              style={{ marginTop: 10, padding: '6px 14px', background: '#22c55e', border: 'none', borderRadius: 7, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-settings-2" style={{ fontSize: 13 }} /> Go to Configuration → Git
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderRightContent() {
    if (activePage !== 'overview') {
      // Block git-dependent pages if repository not initialized
      if (gitNotInitialized && GIT_REQUIRED_PAGES.includes(activePage)) {
        return <GitNotInitializedBanner />;
      }
      switch (activePage) {
        case 'config': {
          // Git Setup stays in Configuration; Git workflow (Changes/PRs/History/Terminal) is separate sidebar item
          const CFG_TABS = [
            { id: 'environment', label: 'Environment', icon: 'ti-server' },
            { id: 'ai',          label: 'AI',          icon: 'ti-brain' },
            { id: 'git',         label: 'Git Setup',   icon: 'ti-git-branch' },
            { id: 'pipeline',    label: 'Pipeline',    icon: 'ti-git-merge' },
          ];
          return (
            <div>
              {/* Tab bar */}
              <div style={{ display: 'flex', gap: 4, padding: '12px 20px 0', borderBottom: '1px solid #f1f5f9', background: '#fafbfc' }}>
                {CFG_TABS.map(t => (
                  <button key={t.id} onClick={() => setConfigTab(t.id)} style={{
                    padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 13, fontWeight: configTab === t.id ? 700 : 500,
                    color: configTab === t.id ? '#22c55e' : '#64748b',
                    borderBottom: configTab === t.id ? '2px solid #22c55e' : '2px solid transparent',
                    display: 'flex', alignItems: 'center', gap: 6, marginBottom: -1,
                  }}>
                    <i className={`ti ${t.icon}`} style={{ fontSize: 14 }} />{t.label}
                  </button>
                ))}
              </div>
              {/* Tab content */}
              <div style={{ display: configTab === 'environment' ? 'contents' : 'none' }}>
                <Config key={`cfg-${project?.id}-${activeCollection?.id}-${activeEnv}`} project={project} collection={activeCollection} env={activeEnv} envs={collectionEnvs} onEnvChange={setActiveEnv} />
              </div>
              <div style={{ display: configTab === 'ai' ? 'contents' : 'none' }}>
                <Settings page="settings-ai" user={user} theme={theme} onThemeChange={onThemeChange} />
              </div>
              <div style={{ display: configTab === 'git' ? 'contents' : 'none' }}>
                <GitPanel project={project} user={user} setupOnly={true} />
              </div>
              <div style={{ display: configTab === 'pipeline' ? 'contents' : 'none' }}>
                <PipelineConfig project={project} envs={collectionEnvs} user={user} />
              </div>
            </div>
          );
        }
        case 'collections': return <Collections project={project} {...shared} openModalTrigger={collectionsModalTrig} />;
        case 'test-data':   return <TestData project={project} {...shared} uploadTrigger={testDataUploadTrig} generateTrigger={testDataGenerateTrig} />;
        case 'rules':       return <Rules project={project} {...shared} openModalTrigger={rulesModalTrig} />;
        case 'test-suites': return <TestSuites project={project} {...shared} openModalTrigger={testSuitesModalTrig} onAfterSave={refreshJmeterCheck} />;
        case 'alerts':      return <Alerts project={project} {...shared} />;
        case 'runner':      return null; // rendered persistently below to preserve logs state
        case 'analytics':   return <Analytics project={project} collection={activeCollection} env={activeEnv} envs={collectionEnvs} onEnvChange={setActiveEnv} />;
        case 'reports':     return <Reports project={project} collection={activeCollection} env={activeEnv} envs={collectionEnvs} onEnvChange={setActiveEnv} />;
        default: return null;
      }
    }

    // Overview — stat cards + quick access
    return (
      <div style={{ padding: '20px 24px' }}>
        {/* Git not initialized banner on overview */}
        {gitNotInitialized && (
          <div style={{ marginBottom: 20, padding: '14px 18px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <i className="ti ti-git-branch" style={{ color: '#b45309', fontSize: 18, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#b45309' }}>Git Repository Not Initialized</div>
              <div style={{ fontSize: 12, color: '#92400e' }}>Initialize the Git repository to enable script generation, test data upload and test execution.</div>
            </div>
            <button onClick={() => { navigate('config'); setConfigTab('git'); }}
              style={{ padding: '6px 14px', background: '#22c55e', border: 'none', borderRadius: 7, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}>
              Initialize Repository
            </button>
          </div>
        )}
        {/* Stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
          {stats.map(s => (
            <div key={s.label} onClick={() => navigate(s.link)}
              style={{ background: '#fff', borderRadius: 12, padding: '16px 18px', border: '1px solid #e8edf2', borderBottom: `3px solid ${s.color}`, cursor: 'pointer', transition: 'box-shadow .15s, transform .15s' }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,.08)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: .8, textTransform: 'uppercase' }}>{s.label}</span>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: s.iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <i className={`ti ${s.icon}`} style={{ fontSize: 18, color: s.color }} />
                </div>
              </div>
              <div style={{ fontSize: 38, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Quick Access divider */}
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1.4, textAlign: 'center', margin: '0 0 18px', position: 'relative' }}>
          <span style={{ background: '#ffffff', padding: '0 16px', position: 'relative', zIndex: 1 }}>Quick Access</span>
          <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: '#e2e8f0', zIndex: 0 }} />
        </div>

        {/* Quick Access grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          {QUICK_ACCESS.map(qa => (
            <div key={qa.id} onClick={() => navigate(qa.id)}
              style={{ background: '#fff', borderRadius: 12, padding: '20px', border: '1px solid #e8edf2', cursor: 'pointer', transition: 'box-shadow .15s, border-color .15s' }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,.08)'; e.currentTarget.style.borderColor = qa.color + '50'; }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderColor = '#e8edf2'; }}
            >
              <div style={{ width: 44, height: 44, borderRadius: 12, background: qa.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                <i className={`ti ${qa.icon}`} style={{ fontSize: 22, color: qa.color }} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>{qa.label}</div>
              <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.6 }}>{qa.desc}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    /* Full-screen overlay — hides app banner */
    <div id="ws-scroll" style={{ position: 'fixed', inset: 0, overflowY: 'auto', background: '#f1f5f9' }}>
      <div style={{ padding: '24px 24px 32px', minHeight: '100%' }}>

        {/* ── Project header — full width, above the two panels ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          {/* Left: Logo then Org/Project info below */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img src="/favicon.svg" alt="Quarks" style={{ height: 40, width: 40 }} />
              <span style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', letterSpacing: 1.5 }}>QUARKS</span>
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', lineHeight: 1.2 }}>
                {user?.org_name || 'Organization'} - {project?.name}
              </div>
              <div style={{ fontSize: 14, color: '#64748b', marginTop: 4 }}>
                {project?.description || project?.name}
              </div>
            </div>
          </div>
          {/* Right: All Projects button */}
          <button onClick={onBack} style={{ padding: '7px 16px', border: '1px solid #22c55e', borderRadius: 8, background: '#22c55e', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}
            onMouseEnter={e => e.currentTarget.style.opacity = '.85'}
            onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
            <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> All Projects
          </button>
        </div>

        {/* ── Two-panel row: sidebar card + content card ── */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>

          {/* Sidebar column — nav card + git tile stacked */}
          {/* height: calc(100vh - 32px) keeps the column within the viewport so the
              Git tile never scrolls away; the nav card grows to fill remaining space */}
          <div style={{ width: 256, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 16, height: 'calc(100vh - 32px)' }}>

            {/* Sidebar nav card — flex:1 so it fills remaining height above the Git tile */}
            <div style={{
              background: '#ffffff',
              borderRadius: 14,
              border: '1px solid #e2e8f0',
              overflow: 'hidden',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}>
              {/* Workspace */}
              <div style={{ padding: '16px 16px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <img src="/favicon.svg" alt="Quarks" style={{ height: 32, width: 32, flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1.3, marginBottom: 1 }}>Workspace</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>{user?.org_name || 'Organization'}</div>
                </div>
              </div>
              <div style={{ height: 1, background: '#f1f5f9', margin: '0 0 4px' }} />

              {/* Nav items — scrollable if list grows taller than the card */}
              <div style={{ padding: '4px 8px 8px', overflowY: 'auto', flex: 1 }}>
                {NAV_ITEMS.filter(item => item.id !== 'reports' || hasJmeterPlan).map(item => {
                  const active = activePage === item.id;
                  return (
                    <button key={item.id} onClick={() => navigate(item.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '9px 10px', marginBottom: 1, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', background: active ? '#f0fdf4' : 'transparent', boxShadow: active ? 'inset 3px 0 0 #22c55e' : 'none', transition: 'background .12s' }}
                      onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#f8fafc'; }}
                      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, fontSize: 15, background: item.bg, color: item.color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <i className={`ti ${item.icon}`} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: active ? 700 : 500, color: active ? '#16a34a' : '#1e293b', lineHeight: 1.3 }}>{item.label}</div>
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.sub}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Git tile — separate card below the nav */}
            <div style={{
              background: gitDrawerOpen ? '#f0fdf4' : '#ffffff',
              borderRadius: 14,
              border: `1.5px solid ${gitDrawerOpen ? '#86efac' : '#e2e8f0'}`,
              overflow: 'hidden',
              boxShadow: gitDrawerOpen ? '0 0 0 3px rgba(34,197,94,0.12)' : 'none',
              transition: 'all .15s',
            }}>
              <button onClick={() => { setGitDrawerOpen(true); setGitDrawerKey(k => k + 1); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  width: '100%', padding: '12px 14px',
                  border: 'none', cursor: 'pointer',
                  background: 'transparent',
                  fontFamily: 'inherit', textAlign: 'left',
                }}
                onMouseEnter={e => { if (!gitDrawerOpen) { e.currentTarget.closest('div').style.borderColor = '#bbf7d0'; e.currentTarget.closest('div').style.background = '#f0fdf4'; } }}
                onMouseLeave={e => { if (!gitDrawerOpen) { e.currentTarget.closest('div').style.borderColor = '#e2e8f0'; e.currentTarget.closest('div').style.background = '#ffffff'; } }}
              >
                <div style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, fontSize: 15, background: gitDrawerOpen ? '#dcfce7' : '#f0fdf4', color: '#16a34a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <i className="ti ti-git-branch" />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: gitDrawerOpen ? '#15803d' : '#1e293b', lineHeight: 1.3 }}>Git</div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>Changes, commits & PRs</div>
                </div>
                {gitDrawerOpen && (
                  <div style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }}/>
                )}
              </button>
            </div>

          </div>

          {/* ── Git Drawer — slides in from left, covers screen ── */}
          {gitDrawerOpen && (
            <>
              {/* Backdrop — only covers area to the right of the drawer */}
              <div onClick={() => setGitDrawerOpen(false)}
                style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', zIndex: 50, transition: 'opacity .2s' }} />

              {/* Git drawer panel — resizable */}
              <div style={{
                position: 'fixed', top: 0, left: 0, bottom: 0,
                width: drawerWidth, maxWidth: '95vw',
                background: '#fff', zIndex: 51,
                boxShadow: '4px 0 32px rgba(0,0,0,0.15)',
                display: 'flex', flexDirection: 'column',
                overflow: 'hidden',
              }}>
                {/* Drawer header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e2e8f0', background: '#fff', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <i className="ti ti-git-branch" style={{ color: '#16a34a', fontSize: 18 }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Git</div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>Changes, commits & pull requests</div>
                    </div>
                  </div>
                  <button onClick={() => setGitDrawerOpen(false)}
                    style={{ width: 32, height: 32, border: 'none', borderRadius: 8, background: '#f1f5f9', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: '#475569' }}>
                    <i className="ti ti-x" />
                  </button>
                </div>

                {/* GitPanel inside drawer — workflow tabs only */}
                <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                  <GitPanel key={gitDrawerKey} project={project} user={user} workflowOnly={true} drawerWidth={drawerWidth} />
                </div>

                {/* ── Resize handle — drag right edge to resize ── */}
                <div
                  onMouseDown={onResizeStart}
                  title="Drag to resize"
                  style={{
                    position: 'absolute', top: 0, right: 0, bottom: 0,
                    width: 5, cursor: 'col-resize', zIndex: 10,
                    background: 'transparent', transition: 'background .15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.35)'}
                  onMouseLeave={e => { if (!isResizing.current) e.currentTarget.style.background = 'transparent'; }}
                />
              </div>
            </>
          )}


          {/* Right content card — rounded, bordered */}
          {/* --hdr:0 removes the topbar offset from .page padding-top */}
          <div style={{
            flex: 1, minWidth: 0,
            background: '#ffffff',
            borderRadius: 14,
            border: '1px solid #e2e8f0',
            overflow: 'hidden',
            '--hdr': '0px',
          }}>
            {/* Breadcrumb + action button header */}
            {(() => {
              const navItem = NAV_ITEMS.find(n => n.id === activePage);
              const actions = PAGE_ACTIONS[activePage] || [];
              const handleAction = (key) => {
                if (activePage === 'collections')                    setCollectionsModalTrig(t => t + 1);
                if (activePage === 'rules')                          setRulesModalTrig(t => t + 1);
                if (activePage === 'test-data' && key === 'upload')  setTestDataUploadTrig(t => t + 1);
                if (activePage === 'test-data' && key === 'generate') setTestDataGenerateTrig(t => t + 1);
                if (activePage === 'test-suites')                    setTestSuitesModalTrig(t => t + 1);
              };
              return (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid #f1f5f9', background: '#fafbfc', borderRadius: '14px 14px 0 0' }}>
                  {/* Breadcrumb */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#64748b' }}>
                    <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4, color: '#22c55e', fontWeight: 600, fontSize: 13, fontFamily: 'inherit' }}>
                      <i className="ti ti-layout-dashboard" style={{ fontSize: 13 }} /> Dashboard
                    </button>
                    <i className="ti ti-chevron-right" style={{ fontSize: 11, color: '#cbd5e1' }} />
                    <button onClick={() => navigate('overview')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4, color: '#22c55e', fontWeight: 600, fontSize: 13, fontFamily: 'inherit' }}>
                      <i className="ti ti-folder" style={{ fontSize: 13 }} /> {project?.name}
                    </button>
                    {navItem && activePage !== 'overview' && (
                      <>
                        <i className="ti ti-chevron-right" style={{ fontSize: 11, color: '#cbd5e1' }} />
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#475569', fontWeight: 500 }}>
                          <i className={`ti ${navItem.icon}`} style={{ fontSize: 13 }} /> {navItem.label}
                        </span>
                      </>
                    )}
                  </div>
                  {/* Action buttons */}
                  {actions.length > 0 && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      {actions.map(a => (
                        <button key={a.key || a.label} onClick={() => handleAction(a.key)}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: a.color, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'opacity .15s' }}
                          onMouseEnter={e => e.currentTarget.style.opacity = '.85'}
                          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                        >
                          <i className={`ti ${a.icon}`} style={{ fontSize: 14 }} /> {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
            {renderRightContent()}

            {/* Runner rendered persistently so logs survive navigation away and back */}
            {project && (
              <div style={{ display: activePage === 'runner' ? 'block' : 'none' }}>
                <Runner projects={projects || [project]} activeProject={project} activeCollection={activeCollection} activeEnv={activeEnv} onNav={navigate} />
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
