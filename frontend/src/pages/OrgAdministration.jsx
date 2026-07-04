import { useState, useEffect } from 'react';
import api from '../api';
import { useConfirm } from '../hooks/useConfirm';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../hooks/useToast';
import { projectDirName } from '../utils/displayName';
import SMTPConfigPanel from '../components/SMTPConfigPanel';

const ROLE_LABELS = { org_admin: 'Org Admin', user: 'User' };

function RoleBadge({ role }) {
  const isAdmin = role === 'org_admin';
  return (
    <span style={{
      padding: '2px 9px', borderRadius: '10px', fontSize: '11px', fontWeight: 700,
      letterSpacing: '.02em', textTransform: 'uppercase',
      background: isAdmin ? 'rgba(37,99,235,0.08)' : 'var(--color-background-secondary)',
      color: isAdmin ? '#2563eb' : 'var(--color-text-secondary)',
      border: isAdmin ? '1px solid rgba(37,99,235,0.3)' : '1px solid var(--color-border-secondary)',
    }}>
      {ROLE_LABELS[role] || role}
    </span>
  );
}

function InviteStatusBadge({ status }) {
  const meta = {
    accepted: { bg: 'rgba(95,201,120,0.15)', color: '#16a34a', label: 'Accepted' },
    pending:  { bg: 'rgba(245,158,11,0.15)', color: '#b45309', label: 'Pending' },
    expired:  { bg: 'var(--color-background-secondary)', color: 'var(--color-text-tertiary)', label: 'Expired' },
  }[status] || { bg: 'var(--color-background-secondary)', color: 'var(--color-text-tertiary)', label: status };
  return (
    <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: meta.bg, color: meta.color }}>
      {meta.label}
    </span>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px',
      fontSize: '13px', fontWeight: active ? 600 : 400,
      color: active ? 'var(--accent)' : 'var(--color-text-secondary)',
      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent', marginBottom: '-1px',
    }}>
      {children}
    </button>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: 'var(--color-background-primary)',
      border: '1px solid var(--color-border-secondary)',
      borderRadius: '10px',
      padding: '18px',
      marginBottom: '16px',
      ...style,
    }}>
      {children}
    </div>
  );
}

export default function OrgAdministration({ user, projects = [], onNav, onDeleteProject }) {
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const { toast } = useToast();

  const [tab, setTab] = useState('smtp');
  const [license, setLicense] = useState(null);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [orgUsers, setOrgUsers] = useState([]); // regular users + their project assignments
  const [memberSearch, setMemberSearch] = useState('');
  const [actionLoading, setActionLoading] = useState({});
  const [revealedInvite, setRevealedInvite] = useState(null);

  const [inviteForm, setInviteForm] = useState({ email: '', role: 'user' });
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);

  const [assigningProject, setAssigningProject] = useState(null);
  const [selectedUserIds, setSelectedUserIds] = useState([]);

  function reloadAll() {
    Promise.all([
      api.get('/licenses/mine').catch(() => ({ data: { license: null } })),
      api.get('/admin/users').catch(() => ({ data: { users: [] } })),
      api.get('/invites').catch(() => ({ data: { invites: [] } })),
      api.get('/invites/org-users').catch(() => ({ data: { users: [] } })),
    ]).then(([licRes, usersRes, invitesRes, orgUsersRes]) => {
      setLicense(licRes.data.license);
      setMembers(usersRes.data.users || []);
      setInvites(invitesRes.data.invites || []);
      setOrgUsers(orgUsersRes.data.users || []);
    });
  }

  useEffect(() => { reloadAll(); }, []);

  async function sendInvite() {
    if (!inviteForm.email) return;
    setInviting(true); setInviteResult(null);
    try {
      const { data } = await api.post('/invites', { ...inviteForm, frontend_url: window.location.origin });
      setInviteResult({ ok: true, url: data.invite_url, emailSent: data.email_sent });
      setInviteForm(f => ({ ...f, email: '' }));
      reloadAll();
    } catch (e) {
      setInviteResult({ ok: false, msg: e.response?.data?.error || 'Failed to send invite' });
    } finally { setInviting(false); }
  }

  async function revokeInvite(id) {
    await api.delete(`/invites/${id}`);
    setInvites(prev => prev.filter(i => i.id !== id));
  }

  async function deleteAllInvites() {
    const ok = await confirm(`Delete all ${invites.length} invite(s)? This cannot be undone.`, 'Delete All Invites');
    if (!ok) return;
    await Promise.all(invites.map(i => api.delete(`/invites/${i.id}`).catch(() => {})));
    setInvites([]);
    toast('All invites deleted', 'success');
  }

  async function resetUserPassword(userId, userName) {
    const newPass = window.prompt(`Set a new temporary password for "${userName}" (min 8 characters):`);
    if (!newPass) return;
    if (newPass.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }
    setActionLoading(a => ({ ...a, [`reset_${userId}`]: true }));
    try {
      await api.post(`/admin/users/${userId}/reset-password`, { new_password: newPass });
      toast(`Password for ${userName} reset successfully.`, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Reset failed', 'error');
    } finally {
      setActionLoading(a => ({ ...a, [`reset_${userId}`]: false }));
    }
  }

  async function removeMember(userId, name) {
    const ok = await confirm(`Remove "${name}" permanently? This cannot be undone.`, 'Remove User');
    if (!ok) return;
    setMembers(prev => prev.filter(m => m.id !== userId));
    try {
      await api.delete(`/admin/users/${userId}`);
      toast(`"${name}" removed successfully`, 'success');
      reloadAll();
    } catch (e) {
      toast(e.response?.data?.error || 'Delete failed', 'error');
      reloadAll();
    }
  }

  function assignedCountFor(projectId) {
    return orgUsers.filter(u => (u.assigned_project_ids || []).includes(projectId)).length;
  }

  function openAssignModal(project) {
    setAssigningProject(project);
    setSelectedUserIds(orgUsers.filter(u => (u.assigned_project_ids || []).includes(project.id)).map(u => u.id));
  }

  async function saveProjectAssignment() {
    if (!assigningProject) return;
    const before = new Set(orgUsers.filter(u => (u.assigned_project_ids || []).includes(assigningProject.id)).map(u => u.id));
    const after = new Set(selectedUserIds);
    const changed = orgUsers.filter(u => before.has(u.id) !== after.has(u.id));

    await Promise.all(changed.map(u => {
      const current = new Set(u.assigned_project_ids || []);
      if (after.has(u.id)) current.add(assigningProject.id); else current.delete(assigningProject.id);
      return api.put(`/invites/assign/${u.id}`, { project_ids: [...current] });
    }));

    setAssigningProject(null);
    toast('Project access updated', 'success');
    reloadAll();
  }

  if (!license) return <div className="page fade-in" style={{ color: 'var(--color-text-tertiary)' }}>Loading…</div>;

  const filteredMembers = members.filter(m => m.status === 'active' &&
    (!memberSearch.trim() || `${m.name || ''} ${m.email}`.toLowerCase().includes(memberSearch.trim().toLowerCase())));
  const pendingCount = invites.filter(i => i.status === 'pending').length;

  return (
    <div className="page fade-in">
      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '18px' }}>
        <div>
          <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: '12px', fontSize: '10px', fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#2563eb', background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.3)', marginBottom: '10px' }}>
            Org Admin
          </span>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--color-text-primary)' }}>Organization Administration</div>
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginTop: '2px' }}>
            Manage your team members, projects, and access
          </div>
        </div>
        <button className="btn-secondary" onClick={() => onNav && onNav('dashboard')}>
          <i className="ti ti-home" /> Dashboard
        </button>
      </div>

      {/* Limit warning banners */}
      {license.projectsAtLimit && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '14px 16px', marginBottom: '16px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '10px' }}>
          <i className="ti ti-alert-triangle" style={{ color: 'var(--warn)', fontSize: 18, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--warn)' }}>
              Project limit reached — {license.projectCount} / {license.maxProjects} on {license.plan} plan
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              You cannot create more projects until your platform administrator upgrades the plan.
            </div>
          </div>
        </div>
      )}
      {license.usersAtLimit && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '14px 16px', marginBottom: '16px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '10px' }}>
          <i className="ti ti-alert-triangle" style={{ color: 'var(--warn)', fontSize: 18, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--warn)' }}>
              User limit reached — {license.userCount} / {license.maxUsers} on {license.plan} plan
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              You cannot invite more users until your platform administrator upgrades the plan.
            </div>
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 24 }}>
        <div style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid var(--color-border-secondary)', background: 'var(--color-background-primary)' }}>
          <div className="stat-label">Organization</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' }}>{user?.org_name || '—'}</div>
        </div>
        <div style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.08)' }}>
          <div className="stat-label">Members</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: license.usersAtLimit ? 'var(--danger)' : 'var(--color-text-primary)' }}>
            {license.userCount} / {license.maxUsers ?? '∞'}
          </div>
        </div>
        <div style={{
          padding: '14px 16px', borderRadius: 10,
          border: license.projectsAtLimit ? '1px solid rgba(239,68,68,0.35)' : '1px solid var(--color-border-secondary)',
          background: license.projectsAtLimit ? 'rgba(239,68,68,0.08)' : 'var(--color-background-primary)',
        }}>
          <div className="stat-label">Projects</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: license.projectsAtLimit ? 'var(--danger)' : 'var(--color-text-primary)' }}>
            {license.projectCount} / {license.maxProjects ?? '∞'}
          </div>
          {license.projectsAtLimit && <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--danger)', marginTop: 2 }}>LIMIT REACHED</div>}
        </div>
        <div style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid var(--color-border-secondary)', background: 'var(--color-background-primary)' }}>
          <div className="stat-label">Plan</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', textTransform: 'uppercase' }}>{license.plan}</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '2px', marginBottom: '20px', borderBottom: '1px solid var(--color-border-secondary)' }}>
        <TabButton active={tab === 'smtp'} onClick={() => setTab('smtp')}>
          SMTP Configuration
        </TabButton>
        <TabButton active={tab === 'invite'} onClick={() => setTab('invite')}>
          Invite Users ({invites.length}{pendingCount > 0 ? ` · ${pendingCount} pending` : ''})
        </TabButton>
        <TabButton active={tab === 'users'} onClick={() => setTab('users')}>
          All Users ({filteredMembers.length})
        </TabButton>
        <TabButton active={tab === 'projects'} onClick={() => setTab('projects')}>
          Projects ({projects.length})
        </TabButton>
      </div>

      {/* ── All Users tab ──────────────────────────────────────────────── */}
      {tab === 'users' && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>Team members</span>
              <span className="badge" style={{ background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)' }}>{filteredMembers.length}</span>
            </div>
            <input type="text" value={memberSearch} onChange={e => setMemberSearch(e.target.value)}
              placeholder="Search members…" style={{ width: 220, fontSize: 12, padding: '6px 10px' }} />
          </div>
          {filteredMembers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No members found.</div>
          ) : filteredMembers.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: 8, marginBottom: 8 }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                {(m.name || m.email)?.[0]?.toUpperCase() || '?'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {m.email}
                  {m.id === user?.id && <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>(you)</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{ROLE_LABELS[m.role] || m.role}</div>
              </div>
              <RoleBadge role={m.role} />
              {m.role === 'user' && (
                <>
                  <button className="btn-secondary btn-sm" title="Reset password" onClick={() => resetUserPassword(m.id, m.name || m.email)} disabled={!!actionLoading[`reset_${m.id}`]}>
                    {actionLoading[`reset_${m.id}`] ? <span className="spinner" /> : <i className="ti ti-key" />}
                  </button>
                  <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)' }} onClick={() => removeMember(m.id, m.name || m.email)}>
                    <i className="ti ti-trash" />
                  </button>
                </>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* ── Invite Users tab ───────────────────────────────────────────── */}
      {tab === 'invite' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
          <Card>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Invite new user</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 16 }}>
              An invite link will be sent to their email address.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 14 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Email address</label>
                <input type="email" value={inviteForm.email} onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="user@company.com" autoComplete="off" />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Role</label>
                <select value={inviteForm.role} onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border-secondary)', background: 'var(--input-bg)', color: 'var(--color-text-primary)', fontSize: '13px' }}>
                  <option value="user">User</option>
                  <option value="org_admin">Org Admin</option>
                </select>
              </div>
            </div>
            <button className="btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={sendInvite}
              disabled={inviting || !inviteForm.email || license.usersAtLimit}>
              {inviting ? <><span className="spinner" />Sending…</> : 'Send Invite'}
            </button>
            {license.usersAtLimit && (
              <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 8 }}>User limit reached — upgrade your plan to invite more.</div>
            )}
            {inviteResult && (
              <div style={{ marginTop: 14, padding: '10px 14px', background: inviteResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${inviteResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, borderRadius: '8px', fontSize: '12px' }}>
                {inviteResult.ok ? (
                  <>
                    <div style={{ color: '#16a34a', fontWeight: 600, marginBottom: 6 }}>Invite created!</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input readOnly value={inviteResult.url} onClick={e => e.target.select()}
                        style={{ flex: 1, padding: '5px 8px', fontSize: '11px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '6px', color: 'var(--accent)' }} />
                      <button className="btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(inviteResult.url); toast('Link copied!', 'success'); }}>Copy</button>
                    </div>
                    {!inviteResult.emailSent && <div style={{ marginTop: 6, color: 'var(--warn)' }}>Email not sent (SMTP not configured) — share the link directly.</div>}
                  </>
                ) : <div style={{ color: 'var(--danger)', fontWeight: 600 }}>{inviteResult.msg}</div>}
              </div>
            )}
          </Card>

          <Card>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>Invites</span>
                <span className="badge" style={{ background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)' }}>{invites.length}</span>
              </div>
              {invites.length > 0 && (
                <button onClick={deleteAllInvites} style={{ background: 'none', border: 'none', color: 'var(--danger)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  Delete all
                </button>
              )}
            </div>
            {invites.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No invites yet.</div>
            ) : invites.map(inv => (
              <div key={inv.id} style={{ padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{inv.email}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{ROLE_LABELS[inv.role] || inv.role}</div>
                  </div>
                  <InviteStatusBadge status={inv.status} />
                  {inv.status === 'pending' && (
                    <button className="btn-secondary btn-sm" onClick={() => setRevealedInvite(r => r === inv.id ? null : inv.id)}>
                      Show link
                    </button>
                  )}
                  <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)' }} onClick={() => revokeInvite(inv.id)}>
                    Delete
                  </button>
                </div>
                {revealedInvite === inv.id && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
                    <input readOnly value={`${window.location.origin}/accept-invite/${inv.token}`} onClick={e => e.target.select()}
                      style={{ flex: 1, padding: '5px 8px', fontSize: '11px', background: 'var(--color-background-primary)', border: '1px solid var(--color-border-secondary)', borderRadius: '6px', color: 'var(--accent)' }} />
                    <button className="btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/accept-invite/${inv.token}`); toast('Link copied!', 'success'); }}>
                      Copy
                    </button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* ── SMTP Configuration tab ─────────────────────────────────────── */}
      {tab === 'smtp' && (
        <Card style={{ maxWidth: 700 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>SMTP configuration</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 16 }}>
            Used to send invite emails and post-run alert emails to users.
          </div>
          <SMTPConfigPanel currentUser={user} standalone={false} showHelp={false} />
        </Card>
      )}

      {/* ── Projects tab ───────────────────────────────────────────────── */}
      {tab === 'projects' && (
        <div>
          {projects.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-tertiary)' }}>No projects yet.</div>
          ) : projects.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', background: 'var(--color-background-primary)', border: '1px solid var(--color-border-secondary)', borderRadius: 8, marginBottom: 8 }}>
              <div style={{ width: 34, height: 34, borderRadius: 7, background: p.bg || '#e0faf3', color: p.color || '#00c896', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
                {projectDirName(p)?.[0]?.toUpperCase() || '?'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{projectDirName(p)}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{assignedCountFor(p.id)} user(s) assigned</div>
              </div>
              <button className="btn-secondary btn-sm" onClick={() => openAssignModal(p)}>Assign Users</button>
              {onDeleteProject && (
                <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)' }} onClick={() => onDeleteProject(p.id)}>Delete</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Assign users to project modal */}
      {assigningProject && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--color-background-primary)', borderRadius: '12px', padding: '24px', width: '460px', maxWidth: '95vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ fontWeight: 700, fontSize: '16px' }}>Assign Users — {projectDirName(assigningProject)}</div>
              <button className="btn-icon" onClick={() => setAssigningProject(null)}><i className="ti ti-x" /></button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {orgUsers.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No regular users to assign yet.</div>
              ) : orgUsers.map(u => (
                <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: '8px', border: `1px solid ${selectedUserIds.includes(u.id) ? 'var(--accent)' : 'var(--color-border-secondary)'}`, cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedUserIds.includes(u.id)}
                    onChange={e => setSelectedUserIds(prev => e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id))}
                    style={{ accentColor: 'var(--accent)', width: 16, height: 16, flexShrink: 0 }} />
                  <span style={{ fontSize: '13px', fontWeight: 500 }}>{u.name || u.email}</span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setAssigningProject(null)}>Cancel</button>
              <button className="btn-primary" onClick={saveProjectAssignment}><i className="ti ti-check" /> Save Access</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
