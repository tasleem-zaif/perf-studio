import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import api from '../api';
import { useToast } from '../hooks/useToast';

const PROVIDERS = [
  { value: 'github',    label: 'GitHub',    placeholder: 'https://github.com/org/repo.git' },
  { value: 'gitlab',    label: 'GitLab',    placeholder: 'https://gitlab.com/org/repo.git' },
  { value: 'bitbucket', label: 'Bitbucket', placeholder: 'https://bitbucket.org/org/repo.git' },
];

const QUICK_CMDS = [
  { label: 'status',       cmd: 'status' },
  { label: 'log --oneline', cmd: 'log --oneline -10' },
  { label: 'diff',         cmd: 'diff' },
  { label: 'branch -a',    cmd: 'branch -a' },
  { label: 'stash list',   cmd: 'stash list' },
];

const FILE_TYPE = {
  M: { label: 'M', bg: '#fef3c7', color: '#b45309', title: 'Modified' },
  A: { label: 'A', bg: '#dcfce7', color: '#16a34a', title: 'Added' },
  D: { label: 'D', bg: '#fee2e2', color: '#dc2626', title: 'Deleted' },
  R: { label: 'R', bg: '#dbeafe', color: '#1d4ed8', title: 'Renamed' },
  '?': { label: 'U', bg: '#ede9fe', color: '#7c3aed', title: 'Untracked' },
};

function StatusBadge({ status }) {
  const map = {
    open:   { bg: '#dbeafe', color: '#1d4ed8', label: 'Open' },
    merged: { bg: '#dcfce7', color: '#16a34a', label: 'Merged' },
    closed: { bg: '#f3f4f6', color: '#6b7280', label: 'Closed' },
  };
  const s = map[status] || map.open;
  return <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color }}>{s.label}</span>;
}

function Section({ title, subtitle, children, extra }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{title}</div>
          {subtitle && <div style={{ fontSize: 13, color: '#64748b', marginTop: 3 }}>{subtitle}</div>}
        </div>
        {extra}
      </div>
      {children}
    </div>
  );
}

function Field({ label, required, hint, children }) {
  return (
    <div className="form-group" style={{ marginBottom: 14 }}>
      <label className="form-label" style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5 }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: 3 }}>(required)</span>}
      </label>
      {children}
      {hint && <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function InlineAlert({ type, children }) {
  const styles = {
    warn:    { bg: '#fffbeb', border: '#fde68a', color: '#b45309', icon: 'ti-alert-triangle' },
    success: { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d', icon: 'ti-circle-check' },
    error:   { bg: '#fef2f2', border: '#fecaca', color: '#b91c1c', icon: 'ti-circle-x' },
    info:    { bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8', icon: 'ti-info-circle' },
  };
  const s = styles[type] || styles.info;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', background: s.bg, border: `1px solid ${s.border}`, borderRadius: 8, marginBottom: 12 }}>
      <i className={`ti ${s.icon}`} style={{ color: s.color, fontSize: 15, flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 13, color: s.color, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

// Parse status response into unified file list
function parseStatusFiles(status) {
  if (!status) return [];
  const files = [];
  const seen = new Set();
  const add = (path, type) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    files.push({ path, type: FILE_TYPE[type] ? type : '?' });
  };
  (status.staged   || []).forEach(f => add(f, 'A'));
  (status.modified || []).forEach(f => add(f, 'M'));
  (status.deleted  || []).forEach(f => add(f, 'D'));
  (status.not_added|| []).forEach(f => add(f, '?'));
  return files;
}

export default function GitPanel({ project, user, workflowOnly = false, setupOnly = false, drawerWidth = 700 }) {
  const { toast } = useToast();
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin';
  // Only the project owner can modify shared git/CI config
  const isProjectOwner = project && user && String(project.user_id) === String(user.id);
  const pid = project?.id;
  const termInputRef = useRef(null);

  // ── Tab ──────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState(workflowOnly ? 'changes' : 'setup');

  // ── Repo config ───────────────────────────────────────────────────────────
  const [cfg,         setCfg]         = useState(null);
  const [cfgForm,     setCfgForm]     = useState({ provider: 'github', remote_url: '', base_branch: 'main', username: '', email: '', auth_token: '' });
  const [cfgEditMode, setCfgEditMode] = useState(false);   // locked / edit toggle
  const [savingCfg,   setSavingCfg]   = useState(false);
  const [initing,     setIniting]     = useState(false);
  const [testing,     setTesting]     = useState(false);
  const [testResult,  setTestResult]  = useState(null);   // { ok, message }

  // ── Identity ──────────────────────────────────────────────────────────────
  const [identity,       setIdentity]       = useState(null);
  const [idForm,         setIdForm]         = useState({ branch_name: '', author_name: user?.name || '', author_email: user?.email || '', auth_token: '' });
  const [savingId,       setSavingId]       = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [autoIniting,    setAutoIniting]    = useState(false);
  const [testingId,      setTestingId]      = useState(false);
  const [testIdResult,   setTestIdResult]   = useState(null); // { ok, message, preview }

  // ── Git state ─────────────────────────────────────────────────────────────
  const [status,   setStatus]   = useState(null);
  const [branches, setBranches] = useState([]);
  const [log,      setLog]      = useState([]);
  const [prs,      setPrs]      = useState([]);
  const [opLog,    setOpLog]    = useState([]);

  // ── Changes tab ───────────────────────────────────────────────────────────
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [diffFile,      setDiffFile]      = useState(null);
  const [diffContent,   setDiffContent]   = useState('');
  const [loadingDiff,   setLoadingDiff]   = useState(false);
  const [isNewFile,     setIsNewFile]     = useState(false);
  const [discarding,    setDiscarding]    = useState(false);
  const [fetching,      setFetching]      = useState(false);
  const [syncing,       setSyncing]       = useState(false);
  const [committing,    setCommitting]    = useState(false);
  const [pushing,       setPushing]       = useState(false);
  const [pulling,       setPulling]       = useState(false);
  const [commitMsg,     setCommitMsg]     = useState('');

  // ── PR state ──────────────────────────────────────────────────────────────
  const [prForm,      setPrForm]      = useState({ title: '', description: '' });
  const [creatingPr,  setCreatingPr]  = useState(false);
  const [mergingPr,   setMergingPr]   = useState(null);

  // ── Terminal ──────────────────────────────────────────────────────────────
  const [termInput,    setTermInput]    = useState('');
  const [termOutput,   setTermOutput]   = useState([{ text: 'Git terminal ready. Type a command or use the quick buttons below.', type: 'info' }]);
  const [termHistory,  setTermHistory]  = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [termRunning,  setTermRunning]  = useState(false);

  const addLog = (msg, type = 'info') =>
    setOpLog(prev => [...prev.slice(-49), { msg, type, ts: new Date().toLocaleTimeString() }]);

  // Use DB flag (cfg.is_initialized) as the source of truth.
  // status.initialized only reflects the LOCAL workspace which may not exist yet
  // for regular users (their workspace is cloned on first commit).
  const initialized  = !!(cfg?.is_initialized || status?.initialized);
  const currentBranch = status?.branch || identity?.branch_name || '—';
  // Filter out .gitkeep files — they are internal placeholders for empty folders
  // and are committed automatically along with all other files
  const allStatusFiles = parseStatusFiles(status);
  const statusFiles    = allStatusFiles.filter(f => !f.path.endsWith('.gitkeep'));
  const openPrs      = prs.filter(p => p.status === 'open').length;
  const baseBranch   = cfgForm.base_branch || cfg?.base_branch || 'main';
  const branchConflict = idForm.branch_name && idForm.branch_name === baseBranch;

  // ── Load all ──────────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    if (!pid) return;
    try {
      const [cfgRes, idRes, prsRes, statusRes] = await Promise.all([
        api.get(`/projects/${pid}/git/config`),
        api.get(`/projects/${pid}/git/identity`),
        api.get(`/projects/${pid}/git/prs`),
        api.get(`/projects/${pid}/git/status`).catch(() => ({ data: { initialized: false } })),
      ]);
      const c = cfgRes.data.config;
      setCfg(c);
      if (c) {
        setCfgForm({ provider: c.provider||'github', remote_url: c.remote_url||'', base_branch: c.base_branch||'main', username: c.username||'', email: c.email||'', auth_token: '' });
        setCfgEditMode(!c.remote_url); // start in edit mode only if not yet configured
      }
      const id = idRes.data.identity;
      setIdentity(id);
      if (id) setIdForm(f => ({ ...f, branch_name: id.branch_name||'', author_name: id.author_name||f.author_name, author_email: id.author_email||f.author_email, auth_token: '' }));
      setPrs(prsRes.data.prs || []);
      setStatus(statusRes.data);
      if (statusRes.data?.initialized) {
        const [logRes, branchRes] = await Promise.all([
          api.get(`/projects/${pid}/git/log`).catch(() => ({ data: { commits: [] } })),
          api.get(`/projects/${pid}/git/branches`).catch(() => ({ data: { branches: [] } })),
        ]);
        setLog(logRes.data.commits || []);
        setBranches(branchRes.data.branches || []);
      }
    } catch (e) { console.error('Git load error:', e.message); }
  }, [pid]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Save repo config ──────────────────────────────────────────────────────
  async function saveRepoConfig(e) {
    e.preventDefault();
    setSavingCfg(true);
    setTestResult(null);
    try {
      await api.put(`/projects/${pid}/git/config`, cfgForm);
      toast('Repository settings saved', 'success');
      setCfgEditMode(false);
      loadAll();
    } catch (err) { toast(err.response?.data?.error || 'Save failed', 'error'); }
    finally { setSavingCfg(false); }
  }

  // ── Test connection ───────────────────────────────────────────────────────
  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await api.post(`/projects/${pid}/git/test`);
      setTestResult({ ok: true, message: data.message, preview: data.token_preview });
    } catch (err) {
      setTestResult({ ok: false, message: err.response?.data?.error || 'Connection failed' });
    } finally { setTesting(false); }
  }

  // ── Init repo ─────────────────────────────────────────────────────────────
  async function initRepo() {
    setIniting(true);
    addLog('Initializing repository…');
    try {
      const { data } = await api.post(`/projects/${pid}/git/init`);
      addLog(data.message, 'success');
      toast(data.message, 'success');
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Init failed';
      addLog(msg, 'error');
      toast(msg, 'error');
    } finally { setIniting(false); }
  }

  // ── Test connection using user's personal PAT ─────────────────────────────
  async function testIdentityConnection() {
    // Save identity first if token field has a new value
    if (idForm.auth_token) {
      setSavingId(true);
      try { await api.put(`/projects/${pid}/git/identity`, idForm); } catch {}
      finally { setSavingId(false); }
    }
    setTestingId(true);
    setTestIdResult(null);
    try {
      const { data } = await api.post(`/projects/${pid}/git/test`);
      setTestIdResult({ ok: true, message: data.message, preview: data.token_preview });
    } catch (err) {
      setTestIdResult({ ok: false, message: err.response?.data?.error || 'Connection failed' });
    } finally { setTestingId(false); }
  }

  // ── Save identity (with auto-init) ────────────────────────────────────────
  async function saveIdentity(e) {
    e.preventDefault();
    if (branchConflict) return toast('Branch name cannot be the same as the base branch', 'warn');
    setSavingId(true);
    try {
      await api.put(`/projects/${pid}/git/identity`, idForm);
      toast('Git identity saved', 'success');
      loadAll();
      // Auto-init branch if all fields are set and repo is initialized
      if (initialized && idForm.branch_name && idForm.author_name && idForm.author_email && (idForm.auth_token || identity?.auth_token)) {
        setAutoIniting(true);
        addLog(`Setting up branch "${idForm.branch_name}"…`);
        try {
          const { data } = await api.post(`/projects/${pid}/git/branch`, { branch_name: idForm.branch_name.trim() });
          addLog(data.message, 'success');
          toast(data.message, 'success');
          loadAll();
        } catch (err) {
          addLog(err.response?.data?.error || 'Branch setup failed', 'error');
        } finally { setAutoIniting(false); }
      }
    } catch (err) { toast(err.response?.data?.error || 'Save failed', 'error'); }
    finally { setSavingId(false); }
  }

  // ── Create / switch branch ────────────────────────────────────────────────
  async function createBranch() {
    if (!idForm.branch_name?.trim()) return toast('Enter a branch name first', 'warn');
    if (branchConflict) return toast('Branch name cannot be the same as the base branch', 'warn');
    setCreatingBranch(true);
    addLog(`Creating / switching to branch "${idForm.branch_name}"…`);
    try {
      // Always send branch_name in body so backend uses the current form value,
      // not whatever was previously saved in the DB
      const { data } = await api.post(`/projects/${pid}/git/branch`, { branch_name: idForm.branch_name.trim() });
      addLog(data.message, 'success');
      toast(data.message, 'success');
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Branch operation failed';
      addLog(msg, 'error'); toast(msg, 'error');
    } finally { setCreatingBranch(false); }
  }

  // ── File diff ─────────────────────────────────────────────────────────────
  async function viewDiff(filePath) {
    if (diffFile === filePath) { setDiffFile(null); setDiffContent(''); setIsNewFile(false); return; }
    setDiffFile(filePath);
    setIsNewFile(false);
    setLoadingDiff(true);
    try {
      const { data } = await api.get(`/projects/${pid}/git/diff?path=${encodeURIComponent(filePath)}`);
      setDiffContent(data.diff || '');
      setIsNewFile(!!data.isNewFile);
    } catch { setDiffContent(''); setIsNewFile(false); }
    finally { setLoadingDiff(false); }
  }

  // ── Discard files ─────────────────────────────────────────────────────────
  async function discardFiles(paths) {
    if (!paths.length) return;
    if (!window.confirm(`Discard changes in ${paths.length} file(s)? This cannot be undone.`)) return;
    setDiscarding(true);
    try {
      const { data } = await api.post(`/projects/${pid}/git/discard`, { paths });
      toast(data.message, 'success');
      setSelectedFiles(new Set());
      if (paths.includes(diffFile)) { setDiffFile(null); setDiffContent(''); }
      loadAll();
    } catch (err) { toast(err.response?.data?.error || 'Discard failed', 'error'); }
    finally { setDiscarding(false); }
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────
  async function fetchRemote() {
    setFetching(true);
    addLog('Fetching from remote…');
    try {
      const { data } = await api.post(`/projects/${pid}/git/fetch`);
      addLog(data.message, 'success');
      toast(data.message, 'success');
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Fetch failed';
      addLog(msg, 'error'); toast(msg, 'error');
    } finally { setFetching(false); }
  }

  // ── Sync with main ────────────────────────────────────────────────────────
  async function syncWithMain() {
    setSyncing(true);
    addLog('Syncing with main…');
    try {
      const { data } = await api.post(`/projects/${pid}/git/sync`);
      addLog(data.message, 'success');
      toast(data.message, 'success');
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Sync failed';
      addLog(msg, 'error'); toast(msg, 'error');
    } finally { setSyncing(false); }
  }

  // ── Commit ────────────────────────────────────────────────────────────────
  async function commitChanges() {
    if (!commitMsg.trim()) return toast('Enter a commit message', 'warn');
    setCommitting(true);
    addLog(`Committing: "${commitMsg}"`);
    try {
      const { data } = await api.post(`/projects/${pid}/git/commit`, { message: commitMsg });
      addLog(data.message, 'success');
      toast(data.message, 'success');
      setCommitMsg('');
      setSelectedFiles(new Set()); // clear selection — files are now committed
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Commit failed';
      addLog(msg, 'error'); toast(msg, 'error');
    } finally { setCommitting(false); }
  }

  // ── Push / Pull ───────────────────────────────────────────────────────────
  async function push() {
    setPushing(true); addLog('Pushing to remote…');
    try {
      const { data } = await api.post(`/projects/${pid}/git/push`);
      addLog(data.message, 'success'); toast(data.message, 'success'); loadAll();
    } catch (err) {
      let m = err.response?.data?.error || 'Push failed';
      // Detect GitHub workflow scope error and give a clear actionable message
      if (m.includes('workflow') && m.includes('scope')) {
        m = '⚠️ Push rejected by GitHub: your Personal Access Token is missing the "workflow" scope.\n\n' +
            'The commit contains .github/workflows/ files which require extra permission.\n\n' +
            'Fix: Go to GitHub → Settings → Developer Settings → Personal Access Tokens → ' +
            'edit your token → enable the "workflow" checkbox → Save → update your PAT in Git Identity.';
      }
      addLog(m, 'error'); toast('Push failed — see log for details', 'error');
    }
    finally { setPushing(false); }
  }

  async function pull() {
    setPulling(true); addLog('Pulling from main…');
    try {
      const { data } = await api.post(`/projects/${pid}/git/pull`);
      addLog(data.message, 'success'); toast(data.message, 'success'); loadAll();
    } catch (err) { const m = err.response?.data?.error || 'Pull failed'; addLog(m, 'error'); toast(m, 'error'); }
    finally { setPulling(false); }
  }

  // ── PR actions ────────────────────────────────────────────────────────────
  async function createPR(e) {
    e.preventDefault(); setCreatingPr(true);
    try {
      const { data } = await api.post(`/projects/${pid}/git/prs`, prForm);
      toast(data.remote_pr_url ? 'PR created on GitHub!' : 'PR recorded', 'success');
      setPrForm({ title: '', description: '' }); loadAll();
    } catch (err) { toast(err.response?.data?.error || 'PR creation failed', 'error'); }
    finally { setCreatingPr(false); }
  }

  async function mergePR(prId) {
    setMergingPr(prId);
    try { const { data } = await api.put(`/projects/${pid}/git/prs/${prId}/merge`); toast(data.message, 'success'); loadAll(); }
    catch (err) { toast(err.response?.data?.error || 'Merge failed', 'error'); }
    finally { setMergingPr(null); }
  }

  async function closePR(prId) {
    try { await api.put(`/projects/${pid}/git/prs/${prId}/close`); toast('PR closed', 'success'); loadAll(); }
    catch (err) { toast(err.response?.data?.error || 'Close failed', 'error'); }
  }

  async function pushCloseOnGitHub(prId) {
    try { await api.put(`/projects/${pid}/git/prs/${prId}/push-close`); toast('PR closed on GitHub', 'success'); loadAll(); }
    catch (err) { toast(err.response?.data?.error || 'Failed to close on GitHub', 'error'); }
  }

  // ── Terminal ──────────────────────────────────────────────────────────────
  async function runTermCmd(cmd) {
    const command = (cmd || termInput).trim();
    if (!command) return;
    setTermOutput(prev => [...prev, { text: `git › ${command}`, type: 'cmd' }]);
    setTermInput('');
    setTermHistory(prev => [command, ...prev.slice(0, 49)]);
    setHistoryIndex(-1);
    setTermRunning(true);
    try {
      const { data } = await api.post(`/projects/${pid}/git/exec`, { command });
      setTermOutput(prev => [...prev, { text: data.output || '(no output)', type: data.ok ? 'out' : 'err' }]);
    } catch (err) {
      setTermOutput(prev => [...prev, { text: err.response?.data?.error || 'Command failed', type: 'err' }]);
    } finally { setTermRunning(false); }
  }

  function handleTermKey(e) {
    if (e.key === 'Enter') { runTermCmd(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.min(historyIndex + 1, termHistory.length - 1);
      setHistoryIndex(idx);
      setTermInput(termHistory[idx] || '');
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(historyIndex - 1, -1);
      setHistoryIndex(idx);
      setTermInput(idx === -1 ? '' : termHistory[idx] || '');
    }
  }

  // ── File selection helpers ────────────────────────────────────────────────
  function toggleFile(path) {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }
  function toggleAll() {
    if (selectedFiles.size === statusFiles.length) setSelectedFiles(new Set());
    else setSelectedFiles(new Set(statusFiles.map(f => f.path)));
  }

  // ── Render diff ───────────────────────────────────────────────────────────
  function renderDiff(diff) {
    if (!diff) return null;
    return diff.split('\n').map((line, i) => {
      let color = '#94a3b8', bg = 'transparent';
      if (line.startsWith('+') && !line.startsWith('+++')) { color = '#4ade80'; bg = 'rgba(74,222,128,0.08)'; }
      else if (line.startsWith('-') && !line.startsWith('---')) { color = '#f87171'; bg = 'rgba(248,113,113,0.08)'; }
      else if (line.startsWith('@@')) { color = '#60a5fa'; }
      else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) { color = '#e2e8f0'; }
      return <div key={i} style={{ color, background: bg, padding: '1px 0', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre', lineHeight: 1.6 }}>{line}</div>;
    });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  // workflowOnly = sidebar Git section (Changes, PRs, History, Terminal)
  // setupOnly    = Configuration > Git (Setup only — reserved for future use)
  const allTabs = [
    { id: 'setup',    label: 'Setup',         icon: 'ti-settings-2',       show: !workflowOnly },
    { id: 'changes',  label: 'Changes',       icon: 'ti-git-commit',       show: !setupOnly && initialized, badge: statusFiles.length || null },
    { id: 'prs',      label: 'Pull Requests', icon: 'ti-git-pull-request', show: !setupOnly, badge: openPrs || null },
    { id: 'history',  label: 'History',       icon: 'ti-history',          show: !setupOnly && initialized },
    { id: 'terminal', label: 'Terminal',       icon: 'ti-terminal-2',       show: !setupOnly && initialized },
  ];
  const tabs = allTabs.filter(t => t.show !== false && t.show !== undefined ? true : t.show === undefined);

  // Auto-switch to first visible tab if current tab is hidden
  useEffect(() => {
    if (tabs.length && !tabs.find(t => t.id === tab)) {
      setTab(tabs[0].id);
    }
  }, [workflowOnly, setupOnly, initialized]);

  const closeBtn = (fn) => (
    <button onClick={fn} style={{ display:'flex',alignItems:'center',gap:5,padding:'5px 12px',border:'none',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:12,fontWeight:600,color:'#fff',background:'#ef4444',transition:'opacity .15s' }}
      onMouseEnter={e=>e.currentTarget.style.opacity='.85'} onMouseLeave={e=>e.currentTarget.style.opacity='1'}>
      <i className="ti ti-x" style={{fontSize:12}}/> Close
    </button>
  );

  return (
    <>
    <div className="page fade-in" style={{ paddingTop: workflowOnly || setupOnly ? 18 : undefined }}>

      {/* ── Status bar ────────────────────────────────────────────────────── */}
      {initialized && (
        <div style={{ marginBottom:16, borderRadius:10, border:'1px solid #e2e8f0', overflow:'hidden', background:'#fff' }}>
          {/* Row 1 — branch + refresh */}
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', background:'#f8fafc', borderBottom:'1px solid #f1f5f9' }}>
            <i className="ti ti-git-branch" style={{ color:'#16a34a', fontSize:15, flexShrink:0 }}/>
            <span style={{ fontWeight:700, color:'#0f172a', fontSize:13 }}>{currentBranch}</span>
            {status?.ahead > 0 && (
              <span style={{ display:'flex',alignItems:'center',gap:3,fontSize:11,fontWeight:600,color:'#7c3aed',background:'#ede9fe',padding:'1px 7px',borderRadius:20 }}>
                <i className="ti ti-arrow-up" style={{ fontSize:10 }}/>{status.ahead} ahead
              </span>
            )}
            {status?.behind > 0 && (
              <span style={{ display:'flex',alignItems:'center',gap:3,fontSize:11,fontWeight:600,color:'#ea580c',background:'#ffedd5',padding:'1px 7px',borderRadius:20 }}>
                <i className="ti ti-arrow-down" style={{ fontSize:10 }}/>{status.behind} behind
              </span>
            )}
            {openPrs > 0 && (
              <span style={{ display:'flex',alignItems:'center',gap:3,fontSize:11,fontWeight:600,color:'#1d4ed8',background:'#dbeafe',padding:'1px 7px',borderRadius:20 }}>
                <i className="ti ti-git-pull-request" style={{ fontSize:10 }}/>{openPrs} PR{openPrs>1?'s':''}
              </span>
            )}
            <button className="btn-primary btn-sm" onClick={e => {
                const icon = e.currentTarget.querySelector('i');
                if (icon) {
                  icon.style.transition = 'transform 0.6s ease';
                  icon.style.transform = 'rotate(360deg)';
                  setTimeout(() => { icon.style.transition = 'none'; icon.style.transform = 'rotate(0deg)'; }, 650);
                }
                loadAll();
              }} style={{ marginLeft:'auto' }}>
              <i className="ti ti-refresh"/> Refresh
            </button>
          </div>
          {/* Row 2 — files changed */}
          <div style={{ display:'flex', alignItems:'center', gap:16, padding:'8px 14px' }}>
            {statusFiles.length > 0 ? (
              <span style={{ display:'flex',alignItems:'center',gap:5,fontSize:12,color:'#374151' }}>
                <i className="ti ti-files" style={{ fontSize:13,color:'#64748b' }}/>
                <strong style={{ color:'#0f172a' }}>{statusFiles.length}</strong>
                <span style={{ color:'#64748b' }}>changed file{statusFiles.length!==1?'s':''}</span>
              </span>
            ) : (
              <span style={{ display:'flex',alignItems:'center',gap:6,fontSize:12,color:'#16a34a' }}>
                <i className="ti ti-circle-check" style={{ fontSize:14 }}/> Working tree clean
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div style={{ display:'flex',gap:2,marginBottom:20,borderBottom:'1px solid #e2e8f0' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:'8px 14px',border:'none',background:'none',cursor:'pointer',fontFamily:'inherit',
            fontSize:13,fontWeight:tab===t.id?700:500,
            color:tab===t.id?'#22c55e':'#64748b',
            borderBottom:tab===t.id?'2px solid #22c55e':'2px solid transparent',
            display:'flex',alignItems:'center',gap:6,marginBottom:-1,
          }}>
            <i className={`ti ${t.icon}`} style={{ fontSize:13 }} />
            {t.label}
            {t.badge ? <span style={{ background:t.id==='changes'?'#f59e0b':'#3b82f6',color:'#fff',borderRadius:10,padding:'1px 6px',fontSize:10,fontWeight:700 }}>{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SETUP TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'setup' && (
        <>
          {!cfg?.remote_url && (
            <InlineAlert type="warn">
              <strong>Complete setup before using Git</strong>
              {isAdmin && <div>Configure the remote URL and initialize the repository.</div>}
              <div>Set your personal branch, author details and access token in Git Identity below.</div>
            </InlineAlert>
          )}

          {/* Repository Settings (admin only) */}
          {isAdmin && (
            <Section
              title="Repository"
              subtitle="Shared remote repository for this project."
              extra={
                cfg?.remote_url && !cfgEditMode && isProjectOwner ? (
                  <button className="btn-secondary btn-sm" onClick={() => { setCfgEditMode(true); setTestResult(null); }}>
                    <i className="ti ti-pencil" style={{ fontSize:12 }} /> Edit
                  </button>
                ) : null
              }
            >
              {/* Owner-only guard */}
              {!isProjectOwner && (
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', background:'#fffbeb', border:'1px solid #fde68a', borderRadius:8, marginBottom:12, fontSize:12, color:'#92400e' }}>
                  <i className="ti ti-lock" style={{ fontSize:14, flexShrink:0 }}/>
                  <span>This configuration is managed by the <strong>project owner</strong>. You can view but not modify it.</span>
                </div>
              )}
              {/* Locked display */}
              {cfg?.remote_url && !cfgEditMode ? (
                <>
                  <div style={{ display:'flex',alignItems:'center',gap:8,padding:'10px 14px',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,marginBottom:12 }}>
                    <i className="ti ti-lock" style={{ color:'#94a3b8',fontSize:14 }} />
                    <span style={{ fontFamily:'monospace',fontSize:13,color:'#0f172a',flex:1 }}>{cfg.remote_url}</span>
                    <span style={{ fontSize:11,color:'#94a3b8' }}>{cfg.provider || 'github'} · {cfg.base_branch || 'main'}</span>
                  </div>
                  {/* Test Connection */}
                  <div style={{ display:'flex',alignItems:'center',gap:10,marginBottom: testResult ? 0 : 4 }}>
                    <button className="btn-secondary" onClick={testConnection} disabled={testing}>
                      {testing ? <><span className="spinner"/>Testing…</> : <><i className="ti ti-wifi"/>Test Connection</>}
                    </button>
                    {!initialized && cfg.remote_url && isProjectOwner && (
                      <button className="btn-secondary" onClick={initRepo} disabled={initing}>
                        {initing ? <><span className="spinner"/>Initializing…</> : <><i className="ti ti-git-branch"/>Initialize repository</>}
                      </button>
                    )}
                    {initialized && <span style={{ fontSize:12,color:'#16a34a',display:'flex',alignItems:'center',gap:4 }}><i className="ti ti-circle-check"/>Repository initialized</span>}
                  </div>
                  {testResult && (
                    <div style={{ marginTop:10 }}>
                      <InlineAlert type={testResult.ok ? 'success' : 'error'}>
                        {testResult.message}
                        {testResult.ok && testResult.preview && <span style={{ marginLeft:8,fontFamily:'monospace',color:'#475569' }}>Token: {testResult.preview}</span>}
                      </InlineAlert>
                    </div>
                  )}
                </>
              ) : (
                /* Edit form */
                <form onSubmit={saveRepoConfig}>
                  {cfg?.remote_url && (
                    <InlineAlert type="warn">
                      Changing the repository URL while team members are active will break their local setup.
                    </InlineAlert>
                  )}
                  <Field label="Provider">
                    <select className="form-select" value={cfgForm.provider} onChange={e => setCfgForm(f => ({ ...f, provider: e.target.value }))}>
                      {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Remote URL" required>
                    <input type="url" value={cfgForm.remote_url} onChange={e => setCfgForm(f => ({ ...f, remote_url: e.target.value }))}
                      placeholder={PROVIDERS.find(p => p.value === cfgForm.provider)?.placeholder}
                      style={{ width:'100%',boxSizing:'border-box' }} />
                  </Field>
                  <Field label="Base branch" hint="All feature branches merge into this branch.">
                    <input type="text" value={cfgForm.base_branch} onChange={e => setCfgForm(f => ({ ...f, base_branch: e.target.value }))} placeholder="main" style={{ width:200 }} />
                  </Field>
                  <div style={{ display:'flex',gap:8 }}>
                    <button type="submit" className="btn-primary" disabled={savingCfg || !isProjectOwner}>
                      {savingCfg && <span className="spinner"/>}<i className="ti ti-device-floppy"/> Save repository settings
                    </button>
                    {cfg?.remote_url && (
                      <button type="button" className="btn-secondary" onClick={() => setCfgEditMode(false)}>Cancel</button>
                    )}
                  </div>
                </form>
              )}
            </Section>
          )}

          {/* Git Identity */}
          <Section title="Your Git Identity" subtitle={`Your personal branch and commit details. Push → raise a PR → ${baseBranch}.`}>
            <form onSubmit={saveIdentity}>
              <Field label="Your working branch" required hint={`Push here, then raise a PR → ${baseBranch}.`}>
                <div style={{ display:'flex',gap:8 }}>
                  <input type="text" value={idForm.branch_name}
                    onChange={e => setIdForm(f => ({ ...f, branch_name: e.target.value }))}
                    placeholder="feature/your-name"
                    style={{ flex:1, borderColor: branchConflict ? '#ef4444' : undefined }} />
                  {initialized && (
                    <button type="button" className="btn-secondary" onClick={createBranch} disabled={creatingBranch || !idForm.branch_name || branchConflict}>
                      {creatingBranch ? <span className="spinner"/> : <i className="ti ti-git-branch"/>}
                      {creatingBranch ? ' Creating…' : ' Create / Switch'}
                    </button>
                  )}
                </div>
                {branchConflict && (
                  <div style={{ fontSize:12,color:'#b45309',marginTop:5,display:'flex',alignItems:'center',gap:4 }}>
                    <i className="ti ti-alert-triangle"/> This is the protected base branch — choose a different name like <code>feature/your-name</code>
                  </div>
                )}
              </Field>
              <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:14 }}>
                <Field label="Commit author name">
                  <input type="text" value={idForm.author_name} onChange={e => setIdForm(f => ({ ...f, author_name: e.target.value }))} placeholder="Jane Smith" />
                </Field>
                <Field label="Commit author email">
                  <input type="email" value={idForm.author_email} onChange={e => setIdForm(f => ({ ...f, author_email: e.target.value }))} placeholder="jane@yourorg.com" />
                </Field>
              </div>
              <Field label="Personal access token" required hint="GitHub PAT starting with ghp_ or github_pat_ — never your login password.">
                <input
                  type="text"
                  value={idForm.auth_token}
                  onChange={e => setIdForm(f => ({ ...f, auth_token: e.target.value }))}
                  placeholder={identity?.auth_token ? `(saved — ${cfg?.token_preview || '••••••••'})` : 'ghp_xxxxxxxxxxxxxxxxxxxx'}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ fontFamily: idForm.auth_token ? 'monospace' : 'inherit', letterSpacing: idForm.auth_token ? '0.5px' : 'normal' }}
                />
                {idForm.auth_token && !idForm.auth_token.startsWith('ghp_') && !idForm.auth_token.startsWith('github_pat_') && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#b45309', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <i className="ti ti-alert-triangle" style={{ fontSize: 12 }} />
                    This doesn't look like a GitHub PAT. It should start with <code style={{ background: '#fef3c7', padding: '1px 4px', borderRadius: 3 }}>ghp_</code> or <code style={{ background: '#fef3c7', padding: '1px 4px', borderRadius: 3 }}>github_pat_</code>
                  </div>
                )}
              </Field>
              <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                <button type="submit" className="btn-primary" disabled={savingId || branchConflict}>
                  {(savingId || autoIniting) && <span className="spinner"/>}
                  <i className="ti ti-device-floppy"/>
                  {savingId ? ' Saving…' : autoIniting ? ' Setting up branch…' : ' Save Settings'}
                </button>
                <button type="button" className="btn-secondary" onClick={testIdentityConnection} disabled={testingId}>
                  {testingId ? <><span className="spinner"/>Testing…</> : <><i className="ti ti-wifi"/>Test Connection</>}
                </button>
              </div>

              {/* Test connection result */}
              {testIdResult && (
                <div style={{ marginTop:10, padding:'10px 14px', borderRadius:8, background: testIdResult.ok ? '#f0fdf4' : '#fef2f2', border:`1px solid ${testIdResult.ok ? '#bbf7d0' : '#fecaca'}`, display:'flex', alignItems:'flex-start', gap:8 }}>
                  <i className={`ti ${testIdResult.ok ? 'ti-circle-check' : 'ti-circle-x'}`} style={{ color: testIdResult.ok ? '#16a34a' : '#dc2626', fontSize:16, flexShrink:0, marginTop:1 }}/>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600, color: testIdResult.ok ? '#15803d' : '#b91c1c' }}>
                      {testIdResult.ok ? 'Connection successful!' : 'Connection failed'}
                    </div>
                    <div style={{ fontSize:12, color:'#475569', marginTop:2 }}>
                      {testIdResult.message}
                      {testIdResult.ok && testIdResult.preview && <span style={{ marginLeft:8, fontFamily:'monospace', color:'#64748b' }}>Token: {testIdResult.preview}</span>}
                    </div>
                  </div>
                </div>
              )}
            </form>
          </Section>

          {/* Op log */}
          {opLog.length > 0 && (
            <div style={{ background:'#0f172a',borderRadius:10,padding:'12px 16px',fontFamily:'monospace',fontSize:12 }}>
              {opLog.map((l, i) => (
                <div key={i} style={{ color:l.type==='error'?'#f87171':l.type==='success'?'#4ade80':'#94a3b8',marginBottom:2 }}>
                  <span style={{ color:'#475569',marginRight:8 }}>{l.ts}</span>{l.msg}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          CHANGES TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'changes' && initialized && (
        <>
          {/* Action bar */}
          <div style={{ display:'flex',gap:8,marginBottom:12,flexWrap:'wrap' }}>
            <button className="btn-secondary" onClick={fetchRemote} disabled={fetching}>
              {fetching ? <><span className="spinner"/>Fetching…</> : <><i className="ti ti-cloud-download"/>Fetch</>}
            </button>
            <button className="btn-secondary" onClick={syncWithMain} disabled={syncing}>
              {syncing ? <><span className="spinner"/>Syncing…</> : <><i className="ti ti-refresh"/>Sync with {baseBranch}</>}
            </button>
            <button className="btn-secondary" onClick={pull} disabled={pulling}>
              {pulling ? <><span className="spinner"/>Pulling…</> : <><i className="ti ti-download"/>Pull from {baseBranch}</>}
            </button>
          </div>

          {/* ── Changed Files card ── */}
          <div style={{ background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,marginBottom:16,overflow:'hidden' }}>
            {/* Card header */}
            <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 16px',borderBottom:'1px solid #f1f5f9' }}>
              <div>
                <div style={{ fontSize:14,fontWeight:700,color:'#0f172a' }}>Changed Files</div>
                <div style={{ fontSize:12,color:'#64748b',marginTop:2 }}>{statusFiles.length} file{statusFiles.length!==1?'s':''} · Branch: {currentBranch}</div>
              </div>
              {/* Only show Discard when selected files still exist in the working tree */}
              {selectedFiles.size > 0 && statusFiles.some(f => selectedFiles.has(f.path)) && (
                <button onClick={() => discardFiles([...selectedFiles].filter(p => statusFiles.some(f => f.path === p)))} disabled={discarding}
                  style={{ display:'flex',alignItems:'center',gap:5,padding:'5px 12px',border:'none',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:12,fontWeight:600,color:'#fff',background:'#ef4444',flexShrink:0 }}>
                  {discarding ? <span className="spinner"/> : <i className="ti ti-trash"/>} Discard ({[...selectedFiles].filter(p => statusFiles.some(f => f.path === p)).length})
                </button>
              )}
            </div>

            {statusFiles.length === 0 ? (
              <div style={{ textAlign:'center',padding:'32px 24px',color:'#94a3b8',fontSize:13 }}>
                <i className="ti ti-circle-check" style={{ fontSize:28,display:'block',marginBottom:8,color:'#22c55e' }}/>
                Working tree is clean — nothing to commit
              </div>
            ) : (
              <>
                {/* Select-all row */}
                <div style={{ display:'flex',alignItems:'center',gap:10,padding:'7px 16px',borderBottom:'1px solid #f1f5f9',background:'#f8fafc' }}>
                  <input type="checkbox" checked={selectedFiles.size===statusFiles.length} onChange={toggleAll} style={{ cursor:'pointer',flexShrink:0,width:15,height:15 }}/>
                  <span style={{ fontSize:12,color:'#64748b' }}>Select all ({statusFiles.length} files)</span>
                </div>

                {/* File rows */}
                {statusFiles.map((f, i) => {
                  const ft = FILE_TYPE[f.type] || FILE_TYPE['?'];
                  const isSelected = selectedFiles.has(f.path);
                  const isActive = diffFile === f.path;
                  const parts = f.path.split('/');
                  const fileName = parts[parts.length - 1];
                  const dirPath = parts.slice(0, -1).join('/');
                  return (
                    <div key={i} style={{ borderBottom: i < statusFiles.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
                      <div style={{ display:'flex',alignItems:'center',gap:10,padding:'8px 16px',background:isActive?'#f0fdf4':'transparent',minWidth:0,cursor:'pointer' }}
                        onClick={() => viewDiff(f.path)}
                        onMouseEnter={e=>{ if(!isActive) e.currentTarget.style.background='#f8fafc'; }}
                        onMouseLeave={e=>{ e.currentTarget.style.background=isActive?'#f0fdf4':'transparent'; }}>
                        {/* Checkbox */}
                        <input type="checkbox" checked={isSelected} onChange={() => toggleFile(f.path)} onClick={e=>e.stopPropagation()} style={{ cursor:'pointer',flexShrink:0,width:15,height:15 }}/>
                        {/* Status badge */}
                        <span style={{ width:20,height:20,borderRadius:4,background:ft.bg,color:ft.color,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700,flexShrink:0 }} title={ft.title}>{ft.label}</span>
                        {/* Filename */}
                        <div style={{ flex:1,minWidth:0 }}>
                          <div style={{ fontSize:13,fontWeight:isActive?600:500,color:isActive?'#15803d':'#1e293b',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }} title={f.path}>{fileName}</div>
                          {dirPath && <div style={{ fontSize:11,color:'#94a3b8',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{dirPath}</div>}
                        </div>
                        {/* Discard button */}
                        <button onClick={e => { e.stopPropagation(); discardFiles([f.path]); }} disabled={discarding}
                          style={{ background:'none',border:'1px solid rgba(239,68,68,0.3)',borderRadius:5,cursor:'pointer',padding:'3px 7px',fontSize:11,color:'#ef4444',flexShrink:0 }}>
                          <i className="ti ti-trash" style={{ fontSize:11 }}/>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <Section title="Commit & Push" subtitle={`Committing to: ${currentBranch}`}>
            <div className="form-group">
              <label className="form-label">Commit message</label>
              <input type="text" value={commitMsg} onChange={e => setCommitMsg(e.target.value)} placeholder="feat: describe your changes" onKeyDown={e => e.key==='Enter' && commitChanges()} />
            </div>
            <div style={{ display:'flex',gap:8,flexWrap:'wrap' }}>
              <button className="btn-primary" onClick={commitChanges} disabled={committing || !commitMsg.trim()}>
                {committing ? <><span className="spinner"/>Committing…</> : <><i className="ti ti-git-commit"/>Commit</>}
              </button>
              <button className="btn-secondary" onClick={push} disabled={pushing}>
                {pushing ? <><span className="spinner"/>Pushing…</> : <><i className="ti ti-upload"/>Push to {currentBranch}</>}
              </button>
            </div>
          </Section>

          {opLog.length > 0 && (
            <div style={{ background:'#0f172a',borderRadius:10,padding:'12px 16px',fontFamily:'monospace',fontSize:12 }}>
              {opLog.map((l, i) => (
                <div key={i} style={{ color:l.type==='error'?'#f87171':l.type==='success'?'#4ade80':'#94a3b8',marginBottom:2 }}>
                  <span style={{ color:'#475569',marginRight:8 }}>{l.ts}</span>{l.msg}
                </div>
              ))}
            </div>
          )}
        </>
      )}


      {/* ══════════════════════════════════════════════════════════════════════
          PULL REQUESTS TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'prs' && (
        <>
          {!isAdmin && initialized && (
            <Section title="Raise a Pull Request" subtitle={`Merge "${currentBranch}" → ${baseBranch}`}>
              <form onSubmit={createPR}>
                <Field label="PR Title" required>
                  <input type="text" value={prForm.title} onChange={e => setPrForm(f => ({ ...f, title: e.target.value }))} placeholder="feat: your changes" />
                </Field>
                <Field label="Description">
                  <textarea value={prForm.description} onChange={e => setPrForm(f => ({ ...f, description: e.target.value }))}
                    placeholder="What does this PR change?" rows={3} style={{ width:'100%',resize:'vertical',boxSizing:'border-box' }} />
                </Field>
                <button type="submit" className="btn-primary" disabled={creatingPr || !prForm.title.trim()}>
                  {creatingPr ? <><span className="spinner"/>Creating…</> : <><i className="ti ti-git-pull-request"/>Create Pull Request</>}
                </button>
              </form>
            </Section>
          )}
          <Section title="Pull Requests" subtitle="All PRs for this project.">
            {prs.length === 0 ? (
              <div style={{ textAlign:'center',padding:'24px',color:'#94a3b8' }}>
                <i className="ti ti-git-pull-request" style={{ fontSize:32,display:'block',marginBottom:8 }}/>
                No pull requests yet
              </div>
            ) : (
              <div style={{ display:'flex',flexDirection:'column',gap:10 }}>
                {prs.map(pr => (
                  <div key={pr.id} style={{ border:'1px solid #e2e8f0',borderRadius:10,padding:'14px 16px' }}>
                    <div style={{ display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ display:'flex',alignItems:'center',gap:8,marginBottom:4 }}>
                          <StatusBadge status={pr.status} />
                          <span style={{ fontSize:14,fontWeight:600,color:'#0f172a' }}>{pr.title}</span>
                        </div>
                        <div style={{ fontSize:12,color:'#64748b',display:'flex',gap:12,flexWrap:'wrap' }}>
                          <span><i className="ti ti-git-branch" style={{ marginRight:3 }}/>{pr.source_branch || pr.from_branch} → {pr.target_branch || 'main'}</span>
                          <span>by {pr.author_name || 'Unknown'}</span>
                          {pr.remote_pr_url && <a href={pr.remote_pr_url} target="_blank" rel="noopener noreferrer" style={{ color:'#3b82f6' }}>View on GitHub →</a>}
                        </div>
                        {pr.description && <div style={{ fontSize:12,color:'#475569',marginTop:6 }}>{pr.description}</div>}
                      </div>
                      <div style={{ display:'flex',gap:6,flexShrink:0,flexWrap:'wrap' }}>
                        {pr.status !== 'open' && pr.remote_pr_url && (
                          <button onClick={() => pushCloseOnGitHub(pr.id)} title="Close on GitHub"
                            style={{ display:'flex',alignItems:'center',gap:5,padding:'5px 12px',border:'none',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:12,fontWeight:600,color:'#fff',background:'#ef4444',transition:'opacity .15s' }}
                            onMouseEnter={e=>e.currentTarget.style.opacity='.85'} onMouseLeave={e=>e.currentTarget.style.opacity='1'}>
                            <i className="ti ti-brand-github" style={{ fontSize:13 }}/> Close on GitHub
                          </button>
                        )}
                        {pr.status === 'open' && (
                          <>
                            {isAdmin && (
                              <button className="btn-primary btn-sm" onClick={() => mergePR(pr.id)} disabled={mergingPr===pr.id}>
                                {mergingPr===pr.id?<span className="spinner"/>:<i className="ti ti-git-merge"/>} Merge
                              </button>
                            )}
                            {closeBtn(() => closePR(pr.id))}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          HISTORY TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'history' && initialized && (
        <Section title="Commit History" subtitle="Recent commits across all branches.">
          {branches.length > 0 && (
            <div style={{ display:'flex',gap:6,flexWrap:'wrap',marginBottom:16 }}>
              {branches.map(b => (
                <span key={b} style={{ padding:'3px 10px',background:b===currentBranch?'#dcfce7':'#f1f5f9',color:b===currentBranch?'#16a34a':'#475569',borderRadius:20,fontSize:12,fontWeight:500,display:'flex',alignItems:'center',gap:4 }}>
                  <i className="ti ti-git-branch" style={{ fontSize:11 }}/>{b}
                  {b===currentBranch && <i className="ti ti-check" style={{ fontSize:10 }}/>}
                </span>
              ))}
            </div>
          )}
          {log.length === 0 ? (
            <div style={{ textAlign:'center',padding:'24px',color:'#94a3b8' }}>No commits yet</div>
          ) : (
            <div>
              {log.map((c, i) => (
                <div key={i} style={{ display:'flex',gap:14,padding:'12px 0',borderBottom:i<log.length-1?'1px solid #f1f5f9':'none' }}>
                  <div style={{ width:32,height:32,borderRadius:'50%',background:'#dcfce7',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>
                    <i className="ti ti-git-commit" style={{ color:'#16a34a',fontSize:14 }}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13,fontWeight:600,color:'#0f172a' }}>{c.message}</div>
                    <div style={{ fontSize:12,color:'#64748b',marginTop:2 }}>
                      {c.author_name} · <span style={{ fontFamily:'monospace' }}>{c.hash?.slice(0,7)}</span> · {c.date}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          TERMINAL TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {tab === 'terminal' && initialized && (
        <div>
          {/* Quick commands */}
          <div style={{ display:'flex',gap:6,flexWrap:'wrap',marginBottom:12 }}>
            {QUICK_CMDS.map(q => (
              <button key={q.cmd} onClick={() => runTermCmd(q.cmd)} disabled={termRunning}
                style={{ padding:'4px 12px',border:'1px solid #334155',borderRadius:6,background:'#1e293b',color:'#94a3b8',cursor:'pointer',fontFamily:'monospace',fontSize:12,transition:'color .12s' }}
                onMouseEnter={e=>e.currentTarget.style.color='#e2e8f0'} onMouseLeave={e=>e.currentTarget.style.color='#94a3b8'}>
                {q.label}
              </button>
            ))}
            <button onClick={() => setTermOutput([{ text:'Terminal cleared.', type:'info' }])}
              style={{ marginLeft:'auto',padding:'4px 12px',border:'1px solid #334155',borderRadius:6,background:'transparent',color:'#64748b',cursor:'pointer',fontSize:12 }}>
              Clear
            </button>
          </div>

          {/* Terminal output */}
          <div style={{ background:'#0f172a',borderRadius:'10px 10px 0 0',border:'1px solid #1e293b',borderBottom:'none',padding:'14px 16px',minHeight:280,maxHeight:400,overflowY:'auto',fontFamily:'monospace',fontSize:13 }}>
            {termOutput.map((line, i) => (
              <div key={i} style={{ marginBottom:3,
                color: line.type==='cmd' ? '#60a5fa' : line.type==='err' ? '#f87171' : line.type==='info' ? '#94a3b8' : '#e2e8f0',
                whiteSpace:'pre-wrap',wordBreak:'break-all',lineHeight:1.6,
              }}>
                {line.text}
              </div>
            ))}
            {termRunning && <div style={{ color:'#f59e0b',marginTop:4 }}>running…</div>}
          </div>

          {/* Terminal input */}
          <div style={{ display:'flex',alignItems:'center',background:'#1e293b',border:'1px solid #334155',borderRadius:'0 0 10px 10px',padding:'10px 14px',gap:8 }}>
            <span style={{ color:'#22c55e',fontFamily:'monospace',fontSize:13,flexShrink:0 }}>git ›</span>
            <input
              ref={termInputRef}
              type="text"
              value={termInput}
              onChange={e => setTermInput(e.target.value)}
              onKeyDown={handleTermKey}
              placeholder="status, log --oneline -10, diff, branch -a…"
              style={{ flex:1,background:'transparent',border:'none',outline:'none',color:'#e2e8f0',fontFamily:'monospace',fontSize:13 }}
              autoComplete="off"
              spellCheck={false}
              disabled={termRunning}
            />
            <button onClick={() => runTermCmd()} disabled={termRunning || !termInput.trim()}
              style={{ padding:'4px 12px',background:'#22c55e',border:'none',borderRadius:5,color:'#fff',cursor:'pointer',fontSize:12,fontWeight:600 }}>
              Run
            </button>
          </div>
          <div style={{ fontSize:11,color:'#475569',marginTop:6,paddingLeft:4 }}>
            ↑↓ arrow keys for command history · Allowed: status, log, diff, branch, stash, show, remote, fetch, and more
          </div>
        </div>
      )}
    </div>

    {/* ══════════════════════════════════════════════════════════════════════
        WINDOW 2 — Diff viewer panel (portal, renders to the right of the drawer)
    ══════════════════════════════════════════════════════════════════════ */}
    {diffFile && createPortal(
      (() => {
        const fileInfo = statusFiles.find(f => f.path === diffFile);
        const ft = FILE_TYPE[fileInfo?.type] || FILE_TYPE['?'];
        const typeLabel = fileInfo?.type === '?' ? 'untracked'
          : fileInfo?.type === 'M' ? 'modified'
          : fileInfo?.type === 'A' ? 'added'
          : fileInfo?.type === 'D' ? 'deleted' : 'changed';
        const typePill = {
          untracked: { bg: '#1f2328', color: '#e6edf3' },
          modified:  { bg: '#9e6a03', color: '#fff' },
          added:     { bg: '#1a7f37', color: '#fff' },
          deleted:   { bg: '#cf222e', color: '#fff' },
          changed:   { bg: '#0969da', color: '#fff' },
        }[typeLabel] || { bg: '#1f2328', color: '#e6edf3' };

        return (
          <div style={{
            position: 'fixed', top: 0, left: drawerWidth, right: 0, bottom: 0,
            zIndex: 52, background: '#ffffff',
            display: 'flex', flexDirection: 'column',
            borderLeft: '1px solid #d1d9e0',
            animation: 'slideInRight .15s ease',
            fontFamily: 'inherit',
          }}>

            {/* ── Header ── */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '0 14px', height: 52, flexShrink: 0,
              borderBottom: '1px solid #d1d9e0', background: '#f6f8fa',
            }}>
              {/* Status badge */}
              <span style={{
                width: 20, height: 20, borderRadius: 4,
                background: ft.bg, color: ft.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 700, flexShrink: 0,
              }}>{ft.label}</span>

              {/* Filename */}
              <span style={{
                flex: 1, minWidth: 0,
                fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
                fontSize: 13, fontWeight: 600, color: '#1f2328',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={diffFile}>{diffFile}</span>

              {/* Type pill */}
              <span style={{
                padding: '2px 9px', borderRadius: 20,
                fontSize: 11, fontWeight: 600, flexShrink: 0,
                background: typePill.bg, color: typePill.color,
              }}>{typeLabel}</span>

              {/* Close */}
              <button onClick={() => { setDiffFile(null); setDiffContent(''); setIsNewFile(false); }}
                style={{
                  width: 26, height: 26, border: 'none', borderRadius: 6,
                  background: 'transparent', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#57606a', flexShrink: 0,
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#eaeef2'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <i className="ti ti-x" style={{ fontSize: 15 }}/>
              </button>
            </div>

            {/* ── New-file notice ── */}
            {isNewFile && (
              <div style={{
                padding: '7px 14px', flexShrink: 0,
                background: '#dafbe1', borderBottom: '1px solid #aceebb',
                fontSize: 12, color: '#116329',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <i className="ti ti-info-circle" style={{ fontSize: 13, flexShrink: 0 }}/>
                New file — entire content shown as additions (no previous version in git history)
              </div>
            )}

            {/* ── Diff / Content body ── */}
            <div style={{ flex: 1, overflowY: 'auto', background: '#ffffff' }}>
              {loadingDiff ? (
                <div style={{ padding: '32px 20px', display: 'flex', alignItems: 'center', gap: 8, color: '#57606a', fontSize: 13 }}>
                  <span className="spinner"/> Loading…
                </div>
              ) : diffContent ? (
                <table style={{
                  width: '100%', borderCollapse: 'collapse',
                  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
                  fontSize: 12, lineHeight: '20px',
                }}>
                  <tbody>
                    {(() => {
                      let lineNum = -1; // will start at 0 for first displayed line
                      return (diffContent || '').split('\n').map((line, i) => {
                        const isAdd  = line.startsWith('+') && !line.startsWith('+++');
                        const isDel  = line.startsWith('-') && !line.startsWith('---');
                        const isHunk = line.startsWith('@@');
                        const isMeta = line.startsWith('diff --git') || line.startsWith('new file') ||
                                       line.startsWith('deleted file') || line.startsWith('old mode') ||
                                       line.startsWith('new mode') || line.startsWith('index ') ||
                                       line.startsWith('--- ') || line.startsWith('+++ ');

                        // Skip meta header lines entirely
                        if (isMeta) return null;

                        // Hunk separator — hidden for new files (entire file is one hunk), shown for modified
                        if (isHunk) {
                          if (isNewFile) return null; // suppress for cleaner new-file view
                          return (
                            <tr key={i} style={{ background: '#ddf4ff' }}>
                              <td style={{ width: 44, padding: '2px 12px 2px 10px', color: '#57606a', textAlign: 'right', userSelect: 'none', borderRight: '1px solid #d1d9e0', fontSize: 11 }}/>
                              <td style={{ width: 26, padding: '2px 6px', color: '#57606a', userSelect: 'none' }}/>
                              <td style={{ padding: '2px 10px', color: '#0550ae', fontSize: 11, whiteSpace: 'pre' }}>{line}</td>
                            </tr>
                          );
                        }

                        // Normal content line — count up from 0
                        lineNum++;

                        const bg   = isAdd ? '#e6ffec' : isDel ? '#ffebe9' : '#ffffff';
                        const color = isAdd ? '#1a7f37' : isDel ? '#cf222e' : '#1f2328';
                        const sign  = isAdd ? '+' : isDel ? '-' : ' ';
                        const text  = (isAdd || isDel) ? line.slice(1) : line;

                        return (
                          <tr key={i} style={{ background: bg }}>
                            {/* Line number */}
                            <td style={{
                              width: 44, padding: '0 10px 0 10px',
                              color: '#6e7781', textAlign: 'right',
                              userSelect: 'none', fontSize: 11, lineHeight: '20px',
                              borderRight: '1px solid #d1d9e0',
                              fontVariantNumeric: 'tabular-nums',
                              background: isAdd ? '#ccffd8' : isDel ? '#ffd7d5' : '#f6f8fa',
                              whiteSpace: 'nowrap',
                            }}>
                              {lineNum}
                            </td>
                            {/* +/- sign */}
                            <td style={{
                              width: 26, padding: '0 6px',
                              color: isAdd ? '#1a7f37' : isDel ? '#cf222e' : '#6e7781',
                              fontWeight: 700, lineHeight: '20px',
                              userSelect: 'none', textAlign: 'center',
                              background: isAdd ? '#ccffd8' : isDel ? '#ffd7d5' : '#f6f8fa',
                            }}>
                              {sign}
                            </td>
                            {/* Code content */}
                            <td style={{
                              padding: '0 10px', color,
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                              lineHeight: '20px',
                            }}>{text || ' '}</td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              ) : (
                <div style={{ padding: '48px 24px', textAlign: 'center', color: '#57606a', fontSize: 13 }}>
                  <i className="ti ti-file-diff" style={{ fontSize: 40, display: 'block', marginBottom: 12, color: '#d1d9e0' }}/>
                  No content available for this file
                </div>
              )}
            </div>

          </div>
        );
      })(),
      document.body
    )}
    </>
  );
}
