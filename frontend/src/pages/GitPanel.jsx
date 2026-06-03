import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useToast } from '../hooks/useToast';

const PROVIDERS = [
  { value: 'github',    label: 'GitHub',    placeholder: 'https://github.com/org/repo.git' },
  { value: 'gitlab',    label: 'GitLab',    placeholder: 'https://gitlab.com/org/repo.git' },
  { value: 'bitbucket', label: 'Bitbucket', placeholder: 'https://bitbucket.org/org/repo.git' },
];

function StatusBadge({ status }) {
  const map = {
    open:   { bg: '#dbeafe', color: '#1d4ed8', label: 'Open' },
    merged: { bg: '#dcfce7', color: '#16a34a', label: 'Merged' },
    closed: { bg: '#f3f4f6', color: '#6b7280', label: 'Closed' },
  };
  const s = map[status] || map.open;
  return (
    <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}

export default function GitPanel({ project, user }) {
  const { toast } = useToast();
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin';
  const pid = project?.id;

  const [tab, setTab] = useState('overview');
  const [cfg, setCfg] = useState(null);
  const [cfgForm, setCfgForm] = useState({ provider: 'github', remote_url: '', username: '', email: '', auth_token: '' });
  const [savingCfg, setSavingCfg] = useState(false);
  const [initing, setIniting] = useState(false);

  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);

  const [prs, setPrs] = useState([]);
  const [prForm, setPrForm] = useState({ title: '', description: '' });
  const [creatingPr, setCreatingPr] = useState(false);
  const [mergingPr, setMergingPr] = useState(null);

  const [log, setLog] = useState([]);
  const [branches, setBranches] = useState([]);
  const [opLog, setOpLog] = useState([]);

  const addLog = (msg, type = 'info') => setOpLog(prev => [...prev.slice(-49), { msg, type, ts: new Date().toLocaleTimeString() }]);

  const loadAll = useCallback(async () => {
    if (!pid) return;
    try {
      const [cfgRes, statusRes, prsRes] = await Promise.all([
        api.get(`/projects/${pid}/git/config`),
        api.get(`/projects/${pid}/git/status`).catch(() => ({ data: { initialized: false } })),
        api.get(`/projects/${pid}/git/prs`),
      ]);
      const c = cfgRes.data.config;
      setCfg(c);
      if (c) setCfgForm({ provider: c.provider||'github', remote_url: c.remote_url||'', username: c.username||'', email: c.email||'', auth_token: '' });
      setStatus(statusRes.data);
      setPrs(prsRes.data.prs || []);

      if (statusRes.data?.initialized) {
        const [logRes, branchRes] = await Promise.all([
          api.get(`/projects/${pid}/git/log`).catch(() => ({ data: { commits: [] } })),
          api.get(`/projects/${pid}/git/branches`).catch(() => ({ data: { branches: [] } })),
        ]);
        setLog(logRes.data.commits || []);
        setBranches(branchRes.data.branches || []);
      }
    } catch (e) {
      console.error('Git load error:', e.message);
    }
  }, [pid]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Save config ──
  async function saveConfig(e) {
    e.preventDefault();
    setSavingCfg(true);
    try {
      await api.put(`/projects/${pid}/git/config`, cfgForm);
      toast('Git configuration saved', 'success');
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Save failed', 'error');
    } finally { setSavingCfg(false); }
  }

  // ── Init repo ──
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

  // ── Commit ──
  async function commitChanges() {
    if (!commitMsg.trim()) return toast('Enter a commit message', 'warn');
    setCommitting(true);
    addLog(`Committing: "${commitMsg}"`);
    try {
      const { data } = await api.post(`/projects/${pid}/git/commit`, { message: commitMsg });
      addLog(data.message, 'success');
      toast(data.message, 'success');
      setCommitMsg('');
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Commit failed';
      addLog(msg, 'error');
      toast(msg, 'error');
    } finally { setCommitting(false); }
  }

  // ── Push ──
  async function push() {
    setPushing(true);
    addLog('Pushing to remote…');
    try {
      const { data } = await api.post(`/projects/${pid}/git/push`);
      addLog(data.message, 'success');
      toast(data.message, 'success');
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Push failed';
      addLog(msg, 'error');
      toast(msg, 'error');
    } finally { setPushing(false); }
  }

  // ── Pull ──
  async function pull() {
    setPulling(true);
    addLog('Pulling from remote…');
    try {
      const { data } = await api.post(`/projects/${pid}/git/pull`);
      addLog(data.message, 'success');
      toast(data.message, 'success');
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Pull failed';
      addLog(msg, 'error');
      toast(msg, 'error');
    } finally { setPulling(false); }
  }

  // ── Create PR ──
  async function createPR(e) {
    e.preventDefault();
    setCreatingPr(true);
    try {
      const { data } = await api.post(`/projects/${pid}/git/prs`, prForm);
      toast(data.remote_pr_url ? 'PR created on GitHub!' : 'PR recorded locally', 'success');
      setPrForm({ title: '', description: '' });
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'PR creation failed', 'error');
    } finally { setCreatingPr(false); }
  }

  // ── Merge PR ──
  async function mergePR(prId) {
    setMergingPr(prId);
    addLog(`Merging PR #${prId}…`);
    try {
      const { data } = await api.put(`/projects/${pid}/git/prs/${prId}/merge`);
      addLog(data.message, 'success');
      toast(data.message, 'success');
      loadAll();
    } catch (err) {
      const msg = err.response?.data?.error || 'Merge failed';
      addLog(msg, 'error');
      toast(msg, 'error');
    } finally { setMergingPr(null); }
  }

  // ── Close PR ──
  async function closePR(prId) {
    try {
      await api.put(`/projects/${pid}/git/prs/${prId}/close`);
      toast('PR closed', 'success');
      loadAll();
    } catch (err) {
      toast(err.response?.data?.error || 'Close failed', 'error');
    }
  }

  if (!project) return <div className="page"><div className="empty"><i className="ti ti-folder-off"/><div className="empty-title">Select a project</div></div></div>;

  const initialized = status?.initialized;
  const userBranch = isAdmin ? 'main' : `users/${user?.name?.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-')}`;
  const TABS = [
    { id: 'overview',  label: 'Overview',  icon: 'ti-git-branch' },
    { id: 'changes',   label: 'Changes',   icon: 'ti-git-commit', show: initialized },
    { id: 'prs',       label: 'Pull Requests', icon: 'ti-git-pull-request', badge: prs.filter(p => p.status === 'open').length || null },
    { id: 'history',   label: 'History',   icon: 'ti-history',    show: initialized },
    ...(isAdmin ? [{ id: 'settings', label: 'Settings', icon: 'ti-settings-2' }] : []),
  ].filter(t => t.show !== false);

  return (
    <div className="page fade-in">
      <div className="breadcrumb">
        <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => {}}>
          <i className="ti ti-layout-dashboard" style={{ fontSize: 12, marginRight: 4 }}/>Dashboard
        </span>
        <i className="ti ti-chevron-right" style={{ fontSize: 12 }}/>
        <span>{project.name}</span>
        <i className="ti ti-chevron-right" style={{ fontSize: 12 }}/>
        <span><i className="ti ti-git-branch" style={{ fontSize: 12, marginRight: 4 }}/>Git</span>
      </div>

      {/* Header */}
      <div className="section-hdr" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <i className="ti ti-git-branch" style={{ fontSize: 20, color: '#22c55e' }}/>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Git Integration</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              {initialized
                ? <><i className="ti ti-circle-check" style={{ color: '#22c55e', marginRight: 4 }}/>Connected · Branch: <strong>{status?.branch || userBranch}</strong></>
                : <><i className="ti ti-circle-x" style={{ color: 'var(--danger)', marginRight: 4 }}/>Not initialized</>
              }
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {initialized && (
            <>
              <button className="btn-secondary btn-sm" onClick={pull} disabled={pulling}>
                {pulling ? <><span className="spinner"/>Pulling…</> : <><i className="ti ti-arrow-bar-to-down"/>Pull</>}
              </button>
              <button className="btn-primary btn-sm" onClick={push} disabled={pushing}>
                {pushing ? <><span className="spinner"/>Pushing…</> : <><i className="ti ti-arrow-bar-up"/>Push</>}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Branch info banner */}
      {initialized && (
        <div style={{ padding: '10px 14px', background: isAdmin ? 'rgba(34,197,94,0.07)' : 'rgba(59,130,246,0.07)', border: `1px solid ${isAdmin ? 'rgba(34,197,94,0.25)' : 'rgba(59,130,246,0.25)'}`, borderRadius: 8, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <i className="ti ti-git-branch" style={{ color: isAdmin ? '#22c55e' : '#3b82f6', fontSize: 16 }}/>
          <span>Your branch: <strong style={{ color: isAdmin ? '#22c55e' : '#3b82f6' }}>{userBranch}</strong></span>
          {status?.ahead > 0 && <span className="tag" style={{ background: 'rgba(34,197,94,0.12)', color: '#16a34a' }}><i className="ti ti-arrow-up" style={{ fontSize: 10 }}/>{status.ahead} ahead</span>}
          {status?.behind > 0 && <span className="tag" style={{ background: 'rgba(239,68,68,0.12)', color: '#dc2626' }}><i className="ti ti-arrow-down" style={{ fontSize: 10 }}/>{status.behind} behind</span>}
          {status?.is_clean && <span style={{ color: 'var(--color-text-tertiary)', fontSize: 12 }}>✓ Working tree clean</span>}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border-secondary)', marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '7px 14px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: tab === t.id ? 700 : 500, color: tab === t.id ? 'var(--accent)' : 'var(--color-text-secondary)', borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent', marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 14 }}/>{t.label}
            {t.badge ? <span style={{ background: '#ef4444', color: '#fff', borderRadius: 10, padding: '0 6px', fontSize: 10, fontWeight: 700 }}>{t.badge}</span> : null}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ── */}
      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Status card */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontWeight: 700, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-info-circle" style={{ color: 'var(--accent)' }}/>Repository Status
            </div>
            {!initialized ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <i className="ti ti-git-branch-deleted" style={{ fontSize: 40, color: 'var(--color-text-tertiary)', display: 'block', marginBottom: 12 }}/>
                <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 16 }}>
                  {isAdmin ? 'Configure git settings and initialize the repository.' : 'Ask your org admin to initialize git for this project.'}
                </div>
                {isAdmin && cfg?.remote_url && (
                  <button className="btn-primary" onClick={initRepo} disabled={initing}>
                    {initing ? <><span className="spinner"/>Initializing…</> : <><i className="ti ti-git-branch"/>Initialize Repository</>}
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  ['Provider', cfg?.provider?.toUpperCase() || '—'],
                  ['Remote', cfg?.remote_url || '—'],
                  ['Current Branch', status?.branch || '—'],
                  ['Modified Files', status?.modified?.length + status?.not_added?.length || 0],
                  ['Uncommitted', status?.staged?.length || 0],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>{k}</span>
                    <span style={{ fontWeight: 600, fontFamily: typeof v === 'string' && v.includes('github') ? 'monospace' : 'inherit', fontSize: 12 }}>{String(v)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Branches card */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontWeight: 700, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-git-branch" style={{ color: '#3b82f6' }}/>Branches
            </div>
            {branches.length === 0 ? (
              <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>No branches yet</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {branches.slice(0, 8).map(b => (
                  <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 8px', borderRadius: 6, background: b === status?.branch ? 'rgba(34,197,94,0.08)' : 'transparent' }}>
                    <i className="ti ti-git-branch" style={{ fontSize: 12, color: b === status?.branch ? '#22c55e' : 'var(--color-text-tertiary)' }}/>
                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{b.replace('remotes/origin/', '')}</span>
                    {b === status?.branch && <span style={{ fontSize: 10, background: '#22c55e', color: '#fff', borderRadius: 4, padding: '1px 6px', marginLeft: 'auto' }}>current</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Operation log */}
          {opLog.length > 0 && (
            <div className="card" style={{ padding: 16, gridColumn: '1/-1' }}>
              <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                <i className="ti ti-terminal" style={{ color: 'var(--accent)' }}/>Operation Log
              </div>
              <div style={{ background: 'var(--color-background-primary)', borderRadius: 6, padding: 12, fontFamily: 'monospace', fontSize: 12, maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
                {opLog.map((l, i) => (
                  <div key={i} style={{ color: l.type === 'error' ? 'var(--danger)' : l.type === 'success' ? '#22c55e' : 'var(--color-text-primary)' }}>
                    <span style={{ color: 'var(--color-text-tertiary)' }}>[{l.ts}] </span>{l.msg}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CHANGES TAB ── */}
      {tab === 'changes' && initialized && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontWeight: 700, marginBottom: 14 }}>Working Changes</div>
            {status?.is_clean ? (
              <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                <i className="ti ti-circle-check" style={{ fontSize: 32, color: '#22c55e', display: 'block', marginBottom: 8 }}/>
                Working tree clean
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16, maxHeight: 200, overflowY: 'auto' }}>
                {[...(status?.modified || []), ...(status?.not_added || [])].map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
                    <span style={{ color: '#f59e0b', fontSize: 10, fontWeight: 700, width: 12 }}>M</span>
                    <span style={{ fontFamily: 'monospace', color: 'var(--color-text-primary)' }}>{f}</span>
                  </div>
                ))}
                {(status?.deleted || []).map(f => (
                  <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
                    <span style={{ color: '#ef4444', fontSize: 10, fontWeight: 700, width: 12 }}>D</span>
                    <span style={{ fontFamily: 'monospace', color: 'var(--color-text-secondary)', textDecoration: 'line-through' }}>{f}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Commit Message</label>
              <input type="text" value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
                placeholder="e.g. Add test data for QA environment"
                onKeyDown={e => e.key === 'Enter' && commitChanges()} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={commitChanges} disabled={committing || !commitMsg.trim()} style={{ flex: 1, justifyContent: 'center' }}>
                {committing ? <><span className="spinner"/>Committing…</> : <><i className="ti ti-git-commit"/>Commit</>}
              </button>
              <button className="btn-secondary" onClick={push} disabled={pushing} style={{ flex: 1, justifyContent: 'center' }}>
                {pushing ? <><span className="spinner"/>Pushing…</> : <><i className="ti ti-arrow-bar-up"/>Push</>}
              </button>
            </div>
          </div>

          {/* Raise PR (regular users only) */}
          {!isAdmin && (
            <div className="card" style={{ padding: 20 }}>
              <div style={{ fontWeight: 700, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className="ti ti-git-pull-request" style={{ color: '#3b82f6' }}/>Raise Pull Request
              </div>
              <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 16, lineHeight: 1.6 }}>
                After pushing your changes, raise a PR to merge your branch <strong style={{ fontFamily: 'monospace' }}>{userBranch}</strong> into <strong>main</strong>.
              </p>
              <form onSubmit={createPR}>
                <div className="form-group">
                  <label className="form-label">PR Title</label>
                  <input type="text" value={prForm.title} onChange={e => setPrForm(f => ({ ...f, title: e.target.value }))}
                    placeholder="e.g. Add QA test data and config" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Description</label>
                  <textarea value={prForm.description} onChange={e => setPrForm(f => ({ ...f, description: e.target.value }))}
                    placeholder="What changes did you make?" rows={3} />
                </div>
                <button className="btn-primary" type="submit" disabled={creatingPr} style={{ width: '100%', justifyContent: 'center' }}>
                  {creatingPr ? <><span className="spinner"/>Creating…</> : <><i className="ti ti-git-pull-request"/>Create Pull Request</>}
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* ── PULL REQUESTS TAB ── */}
      {tab === 'prs' && (
        <div>
          {prs.length === 0 ? (
            <div className="empty">
              <i className="ti ti-git-pull-request"/>
              <div className="empty-title">No pull requests</div>
              <div className="empty-sub">{isAdmin ? 'Team members will raise PRs here.' : 'Push your changes and raise a PR from the Changes tab.'}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {prs.map(pr => (
                <div key={pr.id} className="card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <i className="ti ti-git-pull-request" style={{ fontSize: 20, color: pr.status === 'merged' ? '#22c55e' : pr.status === 'closed' ? '#9ca3af' : '#3b82f6', marginTop: 2, flexShrink: 0 }}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{pr.title}</span>
                      <StatusBadge status={pr.status} />
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', gap: 12 }}>
                      <span><i className="ti ti-user" style={{ marginRight: 4 }}/>{pr.author_name}</span>
                      <span><i className="ti ti-git-branch" style={{ marginRight: 4 }}/>{pr.from_branch} → {pr.to_branch}</span>
                      <span>{new Date(pr.created_at).toLocaleDateString()}</span>
                    </div>
                    {pr.description && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>{pr.description}</div>}
                    {pr.remote_pr_url && (
                      <a href={pr.remote_pr_url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 12, color: 'var(--accent)', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <i className="ti ti-external-link" style={{ fontSize: 11 }}/>View on {pr.remote_pr_url.includes('github') ? 'GitHub' : 'GitLab'}
                      </a>
                    )}
                  </div>
                  {pr.status === 'open' && (
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      {isAdmin && (
                        <button className="btn-primary btn-sm" onClick={() => mergePR(pr.id)} disabled={mergingPr === pr.id}>
                          {mergingPr === pr.id ? <><span className="spinner"/>Merging…</> : <><i className="ti ti-git-merge"/>Merge</>}
                        </button>
                      )}
                      <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)' }} onClick={() => closePR(pr.id)}>
                        <i className="ti ti-x"/>Close
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {tab === 'history' && initialized && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {log.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No commits yet</div>
          ) : log.map((c, i) => (
            <div key={c.hash} style={{ display: 'flex', gap: 14, padding: '12px 18px', borderBottom: i < log.length - 1 ? '1px solid var(--color-border-tertiary)' : 'none', alignItems: 'center' }}>
              <i className="ti ti-git-commit" style={{ color: 'var(--accent)', flexShrink: 0 }}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{c.message}</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', display: 'flex', gap: 10 }}>
                  <span><i className="ti ti-user" style={{ marginRight: 3 }}/>{c.author_name}</span>
                  <span>{c.date?.slice(0, 10)}</span>
                </div>
              </div>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text-tertiary)', background: 'var(--color-background-secondary)', padding: '2px 8px', borderRadius: 4 }}>{c.hash?.slice(0, 7)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── SETTINGS TAB (admin only) ── */}
      {tab === 'settings' && isAdmin && (
        <div style={{ maxWidth: 580 }}>
          <div className="card" style={{ padding: 24 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-settings-2" style={{ color: 'var(--accent)' }}/>Git Configuration
            </div>
            <form onSubmit={saveConfig}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label className="form-label">Git Provider</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {PROVIDERS.map(p => (
                      <button key={p.value} type="button" onClick={() => setCfgForm(f => ({ ...f, provider: p.value }))}
                        style={{ flex: 1, padding: '8px 12px', border: `1.5px solid ${cfgForm.provider === p.value ? 'var(--accent)' : 'var(--color-border-secondary)'}`, borderRadius: 8, background: cfgForm.provider === p.value ? 'rgba(34,197,94,0.08)' : 'transparent', color: cfgForm.provider === p.value ? 'var(--accent)' : 'var(--color-text-secondary)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label className="form-label">Remote URL</label>
                  <input type="text" value={cfgForm.remote_url} onChange={e => setCfgForm(f => ({ ...f, remote_url: e.target.value }))}
                    placeholder={PROVIDERS.find(p => p.value === cfgForm.provider)?.placeholder} required />
                </div>

                <div className="form-group">
                  <label className="form-label">Git Username</label>
                  <input type="text" value={cfgForm.username} onChange={e => setCfgForm(f => ({ ...f, username: e.target.value }))}
                    placeholder="your-github-username" />
                </div>
                <div className="form-group">
                  <label className="form-label">Git Email</label>
                  <input type="email" value={cfgForm.email} onChange={e => setCfgForm(f => ({ ...f, email: e.target.value }))}
                    placeholder="you@company.com" />
                </div>

                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label className="form-label">Personal Access Token (PAT)</label>
                  <input type="password" value={cfgForm.auth_token} onChange={e => setCfgForm(f => ({ ...f, auth_token: e.target.value }))}
                    placeholder={cfg?.auth_token ? '••••••••  (saved — leave blank to keep)' : 'ghp_xxxxxxxxxxxx'} />
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
                    GitHub: Settings → Developer Settings → Personal Access Tokens → Tokens (classic) → repo scope
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn-primary" type="submit" disabled={savingCfg}>
                  {savingCfg ? <><span className="spinner"/>Saving…</> : <><i className="ti ti-device-floppy"/>Save Config</>}
                </button>
                {cfg?.remote_url && !initialized && (
                  <button className="btn-secondary" type="button" onClick={initRepo} disabled={initing}>
                    {initing ? <><span className="spinner"/>Initializing…</> : <><i className="ti ti-git-branch"/>Initialize Repository</>}
                  </button>
                )}
                {cfg?.remote_url && initialized && (
                  <button className="btn-secondary" type="button" onClick={initRepo} disabled={initing}
                    title="Re-run init to commit folder structure and push to remote">
                    {initing ? <><span className="spinner"/>Syncing…</> : <><i className="ti ti-refresh"/>Sync Structure to Remote</>}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
