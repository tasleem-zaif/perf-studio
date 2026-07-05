import { useState, useEffect } from 'react';
import api from '../api';
import CustomSelect from '../components/CustomSelect';
import { useConfirm } from '../hooks/useConfirm';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../hooks/useToast';
import OrganizationsAdmin from './OrganizationsAdmin';
import OrgAdministration from './OrgAdministration';
import SMTPConfigPanel from '../components/SMTPConfigPanel';

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'claude', label: 'Anthropic (Claude)' },
];

// This list is a manually curated snapshot, not a live fetch from OpenAI/Anthropic — it will
// always drift out of date as providers ship new models (confirmed: the Claude entries below
// were stale until this pass). The backend (settings.js) never validates the model string
// against this list — it stores whatever is saved verbatim — so "Custom" exists specifically
// so a newer model never has to wait on someone editing this file to be usable.
const MODELS = {
  openai: [
    { value: 'gpt-4o',          label: 'GPT-4o',            desc: 'Most capable, best quality — recommended' },
    { value: 'gpt-4o-mini',     label: 'GPT-4o Mini',       desc: 'Fast & cheap — good for simple scripts' },
    { value: 'gpt-4-turbo',     label: 'GPT-4 Turbo',       desc: 'High quality, large context window' },
    { value: 'gpt-4',           label: 'GPT-4',             desc: 'Classic GPT-4 — reliable and accurate' },
    { value: 'gpt-3.5-turbo',   label: 'GPT-3.5 Turbo',    desc: 'Fastest & cheapest — basic use only' },
    { value: 'o1-mini',         label: 'o1 Mini',           desc: 'Reasoning model — slower but thorough' },
    { value: 'o3-mini',         label: 'o3 Mini',           desc: 'Latest reasoning model — best for complex fixes' },
    { value: '__custom__',      label: 'Custom (enter model ID)…', desc: 'Type any model ID your OpenAI account has access to — including anything released after this list was last updated.' },
  ],
  claude: [
    { value: 'claude-sonnet-5',              label: 'Claude Sonnet 5',        desc: 'Latest Sonnet — balanced quality & speed, recommended' },
    { value: 'claude-opus-4-8',              label: 'Claude Opus 4.8',       desc: 'Latest Opus — most powerful Claude' },
    { value: 'claude-haiku-4-5-20251001',    label: 'Claude Haiku 4.5',      desc: 'Fastest & cheapest current Claude model' },
    { value: 'claude-fable-5',               label: 'Claude Fable 5',        desc: 'Latest small/fast Claude model' },
    { value: 'claude-opus-4-5',              label: 'Claude Opus 4.5',       desc: 'Previous-generation Opus' },
    { value: 'claude-sonnet-4-5',            label: 'Claude Sonnet 4.5',     desc: 'Previous-generation Sonnet' },
    { value: 'claude-sonnet-4',              label: 'Claude Sonnet 4',       desc: 'Older Sonnet generation' },
    { value: 'claude-haiku-4-5',             label: 'Claude Haiku 4.5 (legacy ID)', desc: 'Older Haiku 4.5 model ID — kept for existing configs' },
    { value: 'claude-3-5-sonnet-20241022',   label: 'Claude 3.5 Sonnet',     desc: 'Older stable production model' },
    { value: 'claude-3-opus-20240229',       label: 'Claude 3 Opus',         desc: 'Older Opus generation' },
    { value: '__custom__',                   label: 'Custom (enter model ID)…', desc: 'Type any model ID your Anthropic account has access to — including anything released after this list was last updated.' },
  ],
};

const DEFAULT_MODEL = { openai: 'gpt-4o', claude: 'claude-sonnet-5' };


const ROLE_LABELS = { super_admin: 'Super Admin', org_admin: 'Org Admin', user: 'User' };
const STATUS_LABELS = { active: 'Active', pending: 'Pending', rejected: 'Rejected' };

function StatusBadge({ status }) {
  const colors = {
    active: { bg: 'rgba(95,201,120,0.15)', color: '#5fc978' },
    pending: { bg: 'rgba(255,180,0,0.15)', color: '#ffb400' },
    rejected: { bg: 'rgba(255,90,90,0.15)', color: '#ff5a5a' },
  };
  const c = colors[status] || colors.pending;
  return (
    <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: c.bg, color: c.color }}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}


/* ── User Management panel ────────────────────────────────────────────── */
function UserManagementPanel({ user, projects = [] }) {
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const { toast } = useToast();
  const [tab, setTab] = useState('invites');
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [orgUsers, setOrgUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [actionLoading, setActionLoading] = useState({});
  // Invite form
  const [inviteForm, setInviteForm] = useState({ email: '', name: '', role: user?.role === 'super_admin' ? 'org_admin' : 'user', org_id: '' });
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  // Organizations (super admin)
  const [orgs, setOrgs] = useState([]);
  const [newOrgName, setNewOrgName] = useState('');
  const [savingOrg, setSavingOrg] = useState(false);
  const [editingOrg, setEditingOrg] = useState(null);
  // Project assignment
  const [assigningUser, setAssigningUser] = useState(null);
  const [selectedProjects, setSelectedProjects] = useState([]);

  function reloadData() {
    setLoadingUsers(true);
    Promise.all([
      api.get('/admin/users').catch(() => ({ data: { users: [] } })),
      api.get('/invites').catch(() => ({ data: { invites: [] } })),
      (user?.role === 'org_admin' ? api.get('/invites/org-users').catch(() => ({ data: { users: [] } })) : Promise.resolve({ data: { users: [] } })),
      (user?.role === 'super_admin' ? api.get('/orgs/managed').catch(() => ({ data: { orgs: [] } })) : Promise.resolve({ data: { orgs: [] } })),
    ]).then(([usersRes, invitesRes, orgUsersRes, orgsRes]) => {
      setUsers(usersRes.data.users || []);
      setInvites(invitesRes.data.invites || []);
      setOrgUsers(orgUsersRes.data.users || []);
      setOrgs(orgsRes.data.orgs || []);
    }).finally(() => setLoadingUsers(false));
  }

  useEffect(() => { reloadData(); }, []);

  async function createOrg() {
    if (!newOrgName.trim()) return;
    setSavingOrg(true);
    try {
      const { data } = await api.post('/orgs', { name: newOrgName.trim() });
      setOrgs(prev => [data.org, ...prev]);
      setNewOrgName('');
      toast(`Organization "${data.org.name}" created`, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to create organization', 'error');
    } finally { setSavingOrg(false); }
  }

  async function saveOrgEdit() {
    if (!editingOrg?.name?.trim()) return;
    try {
      await api.put(`/orgs/${editingOrg.id}`, { name: editingOrg.name });
      setOrgs(prev => prev.map(o => o.id === editingOrg.id ? { ...o, name: editingOrg.name } : o));
      setEditingOrg(null);
      toast('Organization updated', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to update', 'error');
    }
  }

  async function deleteOrg(org) {
    const ok = await confirm(
      `Delete "${org.name}"? This cannot be undone. All members must be removed first.`,
      'Delete Organization'
    );
    if (!ok) return;
    try {
      await api.delete(`/orgs/${org.id}`);
      setOrgs(prev => prev.filter(o => o.id !== org.id));
      toast('Organization deleted', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Cannot delete organization', 'error');
    }
  }

  async function sendInvite() {
    if (!inviteForm.email) return;
    setInviting(true); setInviteResult(null);
    try {
      const payload = { ...inviteForm };
      if (!payload.org_id) delete payload.org_id; // don't send empty string
      // Pass the current app URL so invite links work on any domain (ngrok, LAN IP, production)
      payload.frontend_url = window.location.origin;
      const { data } = await api.post('/invites', payload);
      setInviteResult({ ok: true, url: data.invite_url, msg: data.message, emailSent: data.email_sent });
      setInviteForm(f => ({ ...f, email: '', name: '' }));
      // Refresh invites
      api.get('/invites').then(({ data }) => setInvites(data.invites || []));
    } catch (e) {
      setInviteResult({ ok: false, msg: e.response?.data?.error || 'Failed to send invite' });
    } finally { setInviting(false); }
  }

  async function revokeInvite(id) {
    const inv = invites.find(i => i.id === id);
    const ok = await confirm(
      `Revoke the invitation for "${inv?.email}"? The invite link will stop working.`,
      'Revoke Invite'
    );
    if (!ok) return;
    await api.delete(`/invites/${id}`);
    setInvites(prev => prev.filter(i => i.id !== id));
    toast('Invite revoked', 'success');
  }

  async function saveAssignment() {
    if (!assigningUser) return;
    await api.put(`/invites/assign/${assigningUser.id}`, { project_ids: selectedProjects });
    setOrgUsers(prev => prev.map(u => u.id === assigningUser.id
      ? { ...u, assigned_project_ids: selectedProjects }
      : u
    ));
    setAssigningUser(null);
  }

  async function setStatus(userId, status) {
    setActionLoading(a => ({ ...a, [userId]: true }));
    try {
      await api.put(`/admin/users/${userId}/status`, { status });
      setUsers(u => u.map(x => x.id === userId ? { ...x, status } : x));
      toast(status === 'active' ? 'User activated' : 'User deactivated', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Action failed', 'error');
    } finally {
      setActionLoading(a => ({ ...a, [userId]: false }));
    }
  }

  async function resetUserPassword(userId, userName) {
    const newPass = window.prompt(`Set a new temporary password for "${userName}" (min 8 characters):`);
    if (!newPass) return;
    if (newPass.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }
    setActionLoading(a => ({ ...a, [`reset_${userId}`]: true }));
    try {
      await api.post(`/admin/users/${userId}/reset-password`, { new_password: newPass });
      toast(`Password for ${userName} reset successfully. Share the new password with them.`, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Reset failed', 'error');
    } finally {
      setActionLoading(a => ({ ...a, [`reset_${userId}`]: false }));
    }
  }

  async function removeUser(userId) {
    const u = users.find(x => x.id === userId);
    const ok = await confirm(
      `Remove "${u?.name || 'this user'}" permanently? This cannot be undone.`,
      'Remove User'
    );
    if (!ok) return;
    setActionLoading(a => ({ ...a, [userId]: true }));

    // Optimistic update — remove instantly from UI before API responds
    setUsers(prev => prev.filter(x => x.id !== userId));
    setOrgUsers(prev => prev.filter(x => x.id !== userId));

    try {
      await api.delete(`/admin/users/${userId}`);
      toast(`"${u?.name || 'User'}" removed successfully`, 'success');
      reloadData(); // sync with server to confirm
    } catch (e) {
      // Restore user in list if delete failed
      setUsers(prev => [...prev, u].sort((a, b) => a.name?.localeCompare(b.name)));
      toast(e.response?.data?.error || 'Delete failed', 'error');
    } finally {
      setActionLoading(a => ({ ...a, [userId]: false }));
    }
  }

  const TABS = [
    { id: 'invites', label: 'Send Invite', icon: 'ti-mail-forward' },
    { id: 'pending', label: 'Pending Invites', icon: 'ti-clock', count: invites.filter(i => i.status === 'pending').length },
    { id: 'members', label: 'Active Members', icon: 'ti-users', count: users.filter(u => u.status === 'active' && u.role !== 'super_admin').length },
    ...(user?.role === 'org_admin' ? [{ id: 'assign', label: 'Project Access', icon: 'ti-folder-share' }] : []),
  ];

  return (
    <div className="page fade-in">
      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      {/* Tabs */}
      <div style={{ display: 'flex', gap: '2px', marginBottom: '20px', borderBottom: '1px solid var(--color-border-secondary)' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px',
            fontSize: '13px', fontWeight: tab === t.id ? 600 : 400,
            color: tab === t.id ? 'var(--accent)' : 'var(--color-text-secondary)',
            borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
            marginBottom: '-1px', display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: '13px' }} />
            {t.label}
            {t.count > 0 && <span style={{ background: 'var(--accent)', color: '#fff', borderRadius: '10px', padding: '0 6px', fontSize: '10px', fontWeight: 700 }}>{t.count}</span>}
          </button>
        ))}
      </div>

      {/* ── Organizations (Super Admin only) ───────────────────────────── */}
      {tab === 'organizations' && user?.role === 'super_admin' && (
        <div>
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
            Create and manage organizations. Invite Org Admins under a specific organization.
          </div>

          {/* Create org */}
          <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', maxWidth: 480 }}>
            <input
              type="text" value={newOrgName}
              onChange={e => setNewOrgName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createOrg()}
              placeholder="New organization name…"
              style={{ flex: 1 }}
              autoComplete="off"
            />
            <button className="btn-primary" onClick={createOrg} disabled={savingOrg || !newOrgName.trim()}>
              {savingOrg ? <span className="spinner" /> : <i className="ti ti-plus" />} Add
            </button>
          </div>

          {/* Org list */}
          {orgs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-tertiary)' }}>
              No organizations yet. Create one above.
            </div>
          ) : orgs.map(org => (
            <div key={org.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', background: 'var(--color-background-secondary)', borderRadius: '8px', border: '1px solid var(--color-border-secondary)', marginBottom: '8px' }}>
              <div style={{ width: 36, height: 36, borderRadius: '8px', background: 'rgba(73,204,61,0.12)', border: '1px solid rgba(73,204,61,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <i className="ti ti-building" style={{ color: 'var(--accent)', fontSize: '16px' }} />
              </div>
              {editingOrg?.id === org.id ? (
                <input
                  type="text" value={editingOrg.name}
                  onChange={e => setEditingOrg(o => ({ ...o, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') saveOrgEdit(); if (e.key === 'Escape') setEditingOrg(null); }}
                  style={{ flex: 1, fontSize: '13px' }}
                  autoFocus
                />
              ) : (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-text-primary)' }}>{org.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                    {org.member_count || 0} member{(org.member_count || 0) !== 1 ? 's' : ''}
                    {org.admins && <span> · Admin: {org.admins}</span>}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                {editingOrg?.id === org.id ? (
                  <>
                    <button className="btn-primary btn-sm" onClick={saveOrgEdit}><i className="ti ti-check" /> Save</button>
                    <button className="btn-secondary btn-sm" onClick={() => setEditingOrg(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className="btn-secondary btn-sm" onClick={() => setEditingOrg({ id: org.id, name: org.name })}>
                      <i className="ti ti-pencil" />
                    </button>
                    <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)' }} onClick={() => deleteOrg(org)}>
                      <i className="ti ti-trash" />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Send Invite ─────────────────────────────────────────────────── */}
      {tab === 'invites' && (
        <div style={{ maxWidth: 600 }}>
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
            {user?.role === 'super_admin'
              ? 'Invite Organization Admins. They will receive an email to set up their account.'
              : 'Invite team members or additional Org Admins to your organization. They will receive an email to set up their account.'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Email Address</label>
              <input type="email" value={inviteForm.email} onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))}
                placeholder="colleague@company.com" autoComplete="off" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Name (optional)</label>
              <input type="text" value={inviteForm.name} onChange={e => setInviteForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Their name" autoComplete="off" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Role</label>
              <select value={inviteForm.role} onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border-secondary)', background: 'var(--input-bg)', color: 'var(--color-text-primary)', fontSize: '13px' }}>
                {user?.role === 'super_admin' && <option value="org_admin">Organization Admin</option>}
                {user?.role === 'org_admin' && <option value="org_admin">Organization Admin</option>}
                {user?.role === 'org_admin' && <option value="user">Regular User</option>}
              </select>
            </div>

            {/* Org selector — REQUIRED for super admin inviting org admin */}
            {user?.role === 'super_admin' && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                  Organization
                  <span style={{ color: 'var(--danger)', marginLeft: 3 }}>*</span>
                </label>
                {orgs.length === 0 ? (
                  <div style={{ padding: '10px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '6px', fontSize: '12px', color: 'var(--danger)' }}>
                    <i className="ti ti-alert-triangle" style={{ marginRight: 6 }} />
                    No organizations exist yet. You must
                    <button onClick={() => setTab('organizations')} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: '0 4px', fontSize: '12px', fontWeight: 600, textDecoration: 'underline' }}>
                      create an organization
                    </button>
                    before inviting an Org Admin.
                  </div>
                ) : (
                  <>
                    <select
                      value={inviteForm.org_id}
                      onChange={e => setInviteForm(f => ({ ...f, org_id: e.target.value }))}
                      required
                      style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: `1px solid ${!inviteForm.org_id ? 'var(--danger)' : 'var(--color-border-secondary)'}`, background: 'var(--input-bg)', color: inviteForm.org_id ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', fontSize: '13px' }}
                    >
                      <option value="">— Select an organization —</option>
                      {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                    {!inviteForm.org_id && (
                      <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: 3 }}>
                        Organization is required for Org Admin
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <button className="btn-primary" onClick={sendInvite}
              disabled={inviting || !inviteForm.email || (user?.role === 'super_admin' && !inviteForm.org_id)}>
              {inviting ? <><span className="spinner" />Sending…</> : <><i className="ti ti-send" /> Send Invite</>}
            </button>
            {inviteResult && (
              <div style={{ padding: '12px 14px', background: inviteResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${inviteResult.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, borderRadius: '8px', fontSize: '13px' }}>
                {inviteResult.ok ? (
                  <>
                    <div style={{ color: '#22c55e', fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <i className="ti ti-circle-check" /> Invite created!
                    </div>
                    {inviteResult.url && (
                      <>
                        <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                          <i className="ti ti-link" style={{ marginRight: 4 }} />
                          Share this invite link with the user:
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input readOnly value={inviteResult.url} onClick={e => e.target.select()}
                            style={{ flex: 1, padding: '6px 8px', fontSize: '11px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '6px', color: 'var(--accent)', cursor: 'text' }} />
                          <button
                            className="btn-secondary btn-sm"
                            onClick={() => {
                              navigator.clipboard.writeText(inviteResult.url);
                              toast('Invite link copied!', 'success');
                            }}
                            title="Copy link"
                            style={{ flexShrink: 0, padding: '6px 10px' }}
                          >
                            <i className="ti ti-copy" /> Copy
                          </button>
                        </div>
                        <div style={{ marginTop: 8, padding: '6px 10px', background: inviteResult.emailSent ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.1)', border: `1px solid ${inviteResult.emailSent ? 'rgba(34,197,94,0.25)' : 'rgba(245,158,11,0.25)'}`, borderRadius: '6px', fontSize: '11px', color: inviteResult.emailSent ? '#16a34a' : 'var(--warn)' }}>
                          <i className={`ti ${inviteResult.emailSent ? 'ti-mail-check' : 'ti-mail-off'}`} style={{ marginRight: 4 }} />
                          {inviteResult.emailSent
                            ? 'Invite email sent. If the user does not receive it, ask them to check Spam/Junk folder or share the link above directly.'
                            : 'Email not sent (SMTP not configured). Share the link above directly with the user.'}
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <div style={{ color: 'var(--danger)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <i className="ti ti-circle-x" /> {inviteResult.msg}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Pending Invites ────────────────────────────────────────────── */}
      {tab === 'pending' && (
        <div>
          {invites.filter(i => i.status === 'pending').length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-tertiary)' }}>No pending invites.</div>
          ) : invites.filter(i => i.status === 'pending').map(inv => (
            <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', background: 'var(--color-background-secondary)', borderRadius: '8px', border: '1px solid var(--color-border-secondary)', marginBottom: '8px' }}>
              <i className="ti ti-mail" style={{ fontSize: '18px', color: 'var(--accent)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '13px' }}>{inv.email}</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                  {ROLE_LABELS[inv.role]} · Invited by {inv.inviter_name} · Expires {new Date(inv.expires_at).toLocaleDateString()}
                </div>
              </div>
              <span style={{ fontSize: '11px', background: 'rgba(245,158,11,0.15)', color: 'var(--warn)', borderRadius: '6px', padding: '2px 8px', fontWeight: 600 }}>Pending</span>
              <button className="btn-secondary btn-sm" onClick={() => revokeInvite(inv.id)} style={{ color: 'var(--danger)' }}>
                <i className="ti ti-x" /> Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Active Members ─────────────────────────────────────────────── */}
      {tab === 'members' && (
        <div>
          {users.filter(u => u.status === 'active' && u.role !== 'super_admin').length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-tertiary)' }}>No active members yet. Send invites to add members.</div>
          ) : users.filter(u => u.status === 'active' && u.role !== 'super_admin').map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', background: 'var(--color-background-secondary)', borderRadius: '8px', border: '1px solid var(--color-border-secondary)', marginBottom: '8px' }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '14px', flexShrink: 0 }}>
                {u.name?.[0]?.toUpperCase() || '?'}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '13px' }}>{u.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{u.email}</div>
              </div>
              <span style={{ fontSize: '11px', background: 'var(--color-background)', border: '1px solid var(--color-border-secondary)', borderRadius: '10px', padding: '2px 8px', color: 'var(--color-text-secondary)' }}>
                {ROLE_LABELS[u.role]}
              </span>
              <StatusBadge status={u.status} />
              <button className="btn-secondary btn-sm" title="Reset password"
                onClick={() => resetUserPassword(u.id, u.name)}
                disabled={!!actionLoading[`reset_${u.id}`]}>
                {actionLoading[`reset_${u.id}`]
                  ? <span className="spinner" />
                  : <i className="ti ti-key" />}
              </button>
              <button className="btn-secondary btn-sm" onClick={() => removeUser(u.id)} style={{ color: 'var(--danger)' }}>
                <i className="ti ti-trash" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Project Access (Org Admin only) ────────────────────────────── */}
      {tab === 'assign' && user?.role === 'org_admin' && (
        <div>
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
            Assign projects to regular users. They can only see and use the projects you assign to them.
          </div>
          {orgUsers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-tertiary)' }}>No regular users yet. Invite users first.</div>
          ) : orgUsers.map(u => (
            <div key={u.id} style={{ padding: '14px', background: 'var(--color-background-secondary)', borderRadius: '8px', border: '1px solid var(--color-border-secondary)', marginBottom: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '13px', flexShrink: 0 }}>
                  {u.name?.[0]?.toUpperCase() || '?'}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>{u.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{u.email}</div>
                </div>
                <button className="btn-secondary btn-sm" onClick={() => { setAssigningUser(u); setSelectedProjects(u.assigned_project_ids || []); }}>
                  <i className="ti ti-edit" /> Manage Access
                </button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                {(u.assigned_project_ids || []).length === 0
                  ? '⚠️ No projects assigned — user sees empty dashboard'
                  : `✅ ${(u.assigned_project_ids || []).length} project(s) assigned`}
              </div>
            </div>
          ))}

          {/* Project assignment modal */}
          {assigningUser && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
              <div style={{ background: 'var(--color-background-primary)', borderRadius: '12px', padding: '24px', width: '480px', maxWidth: '95vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <div style={{ fontWeight: 700, fontSize: '16px' }}>Assign Projects — {assigningUser.name}</div>
                  <button className="btn-icon" onClick={() => setAssigningUser(null)}><i className="ti ti-x" /></button>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '14px' }}>
                  Select which projects this user can access. They get full add/edit/delete access to API sources, test data, rules, test plans, and alerts within assigned projects.
                </div>
                <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {projects.map(p => (
                    <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: '8px', border: `1px solid ${selectedProjects.includes(p.id) ? 'var(--accent)' : 'var(--color-border-secondary)'}`, cursor: 'pointer' }}>
                      <input type="checkbox" checked={selectedProjects.includes(p.id)}
                        onChange={e => setSelectedProjects(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))}
                        style={{ accentColor: 'var(--accent)', width: 16, height: 16, flexShrink: 0 }} />
                      <span className="color-dot" style={{ background: p.color }} />
                      <span style={{ fontSize: '13px', fontWeight: 500 }}>{p.name}</span>
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '16px', justifyContent: 'flex-end' }}>
                  <button className="btn-secondary" onClick={() => setAssigningUser(null)}>Cancel</button>
                  <button className="btn-primary" onClick={saveAssignment}>
                    <i className="ti ti-check" /> Save Access
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function ModelRow({ icon, title, subtitle, value, rawValue, onChange, models, iconColor, disabled = false }) {
  // `value` is the effective (fallback-applied) model — used for the dropdown's own
  // selection/description so it shows the real default when nothing's been chosen yet.
  // `rawValue` is the parent's actual unfallback-ed state — used to pre-fill the custom text
  // input, so a fallback default's name never appears as if the admin had typed it in.
  const knownMatch = models.find(m => m.value === rawValue && m.value !== '__custom__');
  // Local "custom mode" flag. Driven by rawValue (below) for external changes — a fresh
  // load delivering a legacy/unlisted saved model, or a provider switch resetting rawValue
  // to '' — but the dropdown's own "Custom" click sets it directly WITHOUT touching
  // rawValue, so the effect (keyed only on rawValue) doesn't immediately fire and revert it.
  const [customMode, setCustomMode] = useState(rawValue !== '' && !knownMatch);
  useEffect(() => {
    if (rawValue === '' || knownMatch) setCustomMode(false);
    else setCustomMode(true);
  }, [rawValue]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectValue = customMode ? '__custom__' : value;
  const selected     = models.find(m => m.value === selectValue);

  return (
    <div style={{
      padding: '14px 16px', marginBottom: '10px',
      background: 'var(--color-background-secondary)',
      border: '1px solid var(--color-border-secondary)',
      borderRadius: 'var(--border-radius-md)',
      opacity: disabled ? 0.7 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
        <i className={`ti ${icon}`} style={{ fontSize: '16px', color: iconColor, marginTop: '1px', flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-text-primary)' }}>{title}</div>
          <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '1px' }}>{subtitle}</div>
        </div>
      </div>
      <CustomSelect
        value={selectValue}
        onChange={e => {
          if (disabled) return;
          const v = e.target.value;
          // Selecting "Custom" is purely a view toggle — it deliberately does NOT clear the
          // underlying value, so whatever model was previously selected stays pre-filled in
          // the text input below for editing rather than being wiped out.
          if (v === '__custom__') setCustomMode(true);
          else { setCustomMode(false); onChange(v); }
        }}
        disabled={disabled}
      >
        {models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
      </CustomSelect>
      {customMode && (
        <input
          type="text"
          className="form-input"
          style={{ marginTop: '8px', width: '100%', boxSizing: 'border-box' }}
          placeholder="e.g. gpt-4.1, o4-mini, claude-opus-5 — exact model ID as your provider names it"
          value={rawValue}
          disabled={disabled}
          onChange={e => !disabled && onChange(e.target.value)}
        />
      )}
      {selected && selected.value !== '__custom__' && (
        <div style={{ marginTop: '7px', fontSize: '11px', color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <i className="ti ti-info-circle" style={{ fontSize: '11px' }} />
          {selected.desc}
        </div>
      )}
    </div>
  );
}

function AIConfigPanel({ user }) {
  const [provider,   setProvider]   = useState('openai');
  const [model,      setModel]      = useState('');
  const [healModel,  setHealModel]  = useState('');
  const [apiKey,     setApiKey]     = useState('');
  const [keySet,     setKeySet]     = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [error,      setError]      = useState('');

  useEffect(() => {
    api.get('/settings/ai').then(({ data }) => {
      setProvider(data.provider || 'openai');
      setModel(data.model || DEFAULT_MODEL[data.provider || 'openai'] || '');
      setHealModel(data.heal_model || '');
      setKeySet(data.api_key_set);
    }).catch(() => {});
  }, []);

  function handleProviderChange(val) {
    setProvider(val);
    setModel(DEFAULT_MODEL[val] || '');
    setHealModel('');
  }

  async function save() {
    if (!apiKey && !keySet) return setError('API key required');
    setSaving(true); setError(''); setSaved(false);
    try {
      const body = {
        provider,
        model:      model      || DEFAULT_MODEL[provider],
        heal_model: healModel  || DEFAULT_MODEL[provider],
      };
      if (apiKey) body.api_key = apiKey;
      await api.put('/settings/ai', body);
      setKeySet(true); setApiKey(''); setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save AI settings — verify the API key is valid and not expired for the selected provider.');
    } finally { setSaving(false); }
  }

  const providerModels  = MODELS[provider] || [];
  const effectiveModel  = model      || DEFAULT_MODEL[provider] || '';
  const effectiveHeal   = healModel  || DEFAULT_MODEL[provider] || '';

  const isRegularUser = user?.role === 'user';

  return (
    <div className="page fade-in" style={{ maxWidth: '560px' }}>

      {/* Read-only notice for regular users */}
      {isRegularUser && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', marginBottom: 20,
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: 8,
        }}>
          <i className="ti ti-info-circle" style={{ color: '#f59e0b', fontSize: 18, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#f59e0b', marginBottom: 2 }}>
              View only — AI Configuration is managed by your Org Admin
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Please contact your administrator to change the AI provider or API key.
            </div>
          </div>
        </div>
      )}

      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
        {isRegularUser
          ? 'AI models configured by your Org Admin for this organization.'
          : 'Configure separate AI models for script generation and auto-healing. Both use the same provider and API key.'}
      </div>

      {!isRegularUser && error && <div className="auth-error" style={{ marginBottom: '16px' }}>{error}</div>}
      {!isRegularUser && saved && (
        <div style={{ marginBottom: '16px', padding: '10px 14px', background: 'rgba(95,201,120,0.12)', border: '1px solid rgba(95,201,120,0.3)', borderRadius: 'var(--border-radius-md)', fontSize: '13px', color: '#5fc978' }}>
          <i className="ti ti-circle-check" style={{ marginRight: '6px' }} />Settings saved successfully.
        </div>
      )}

      {/* Provider */}
      <div className="form-group">
        <label className="form-label">AI Provider</label>
        <CustomSelect value={provider} onChange={e => !isRegularUser && handleProviderChange(e.target.value)} disabled={isRegularUser}>
          {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </CustomSelect>
      </div>

      {/* Script generation model */}
      <ModelRow
        icon="ti-code"
        iconColor="var(--accent)"
        title="Script Generation Model"
        subtitle="Used when generating JMX / K6 scripts from your API collections"
        value={effectiveModel}
        rawValue={model}
        onChange={isRegularUser ? () => {} : setModel}
        models={providerModels}
        disabled={isRegularUser}
      />

      {/* Auto healer model */}
      <ModelRow
        icon="ti-first-aid-kit"
        iconColor="#f59e0b"
        title="Auto Healer Model"
        subtitle="Used when diagnosing and fixing failed test runs (reasoning-heavy — use a smarter model)"
        value={effectiveHeal}
        rawValue={healModel}
        onChange={isRegularUser ? () => {} : setHealModel}
        models={providerModels}
        disabled={isRegularUser}
      />

      {/* API Key — hidden for regular users */}
      {!isRegularUser && <div className="form-group">
        <label className="form-label">
          API Key
          {provider === 'openai' && (
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer"
               style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--accent)', fontWeight: 400 }}>
              Get OpenAI key ↗
            </a>
          )}
          {provider === 'claude' && (
            <a href="https://console.anthropic.com/account/keys" target="_blank" rel="noreferrer"
               style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--accent)', fontWeight: 400 }}>
              Get Anthropic key ↗
            </a>
          )}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={keySet ? '••••••••••••  (key saved — enter new key to update)' : provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
        />
      </div>}

      {!isRegularUser && (
        <button className="btn-primary" onClick={save} disabled={saving} style={{ marginTop: '4px' }}>
          {saving && <span className="spinner" />}
          <i className="ti ti-device-floppy" />Save Settings
        </button>
      )}

    </div>
  );
}

/* ── Licensing panel (super_admin manages all orgs, org_admin views their own) ── */

const PLAN_META = {
  trial:      { label: 'Trial',      color: '#d97706', bg: 'rgba(217,119,6,0.12)' },
  starter:    { label: 'Starter',    color: '#2563eb', bg: 'rgba(37,99,235,0.12)' },
  growth:     { label: 'Growth',     color: '#7c3aed', bg: 'rgba(124,58,237,0.12)' },
  business:   { label: 'Business',   color: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
  enterprise: { label: 'Enterprise', color: '#475569', bg: 'rgba(71,85,105,0.12)' },
};

function PlanBadge({ plan }) {
  const meta = PLAN_META[plan] || { label: plan, color: '#64748b', bg: 'rgba(100,116,139,0.12)' };
  return (
    <span style={{ padding: '2px 9px', borderRadius: '10px', fontSize: '11px', fontWeight: 700, letterSpacing: '.02em', textTransform: 'uppercase', background: meta.bg, color: meta.color }}>
      {meta.label}
    </span>
  );
}

function UsageBar({ label, used, max }) {
  const unlimited = max === null || max === undefined;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(max, 1)) * 100));
  const atLimit = !unlimited && used >= max;
  return (
    <div style={{ minWidth: 140 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--color-text-tertiary)', marginBottom: '3px' }}>
        <span>{label}</span>
        <span style={{ color: atLimit ? 'var(--danger)' : 'var(--color-text-secondary)', fontWeight: 600 }}>
          {used} / {unlimited ? '∞' : max}
        </span>
      </div>
      {!unlimited && (
        <div style={{ height: 5, borderRadius: 3, background: 'var(--color-background-tertiary, #e2e8f0)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, borderRadius: 3, background: atLimit ? 'var(--danger)' : 'var(--accent)', transition: 'width .2s' }} />
        </div>
      )}
    </div>
  );
}

function ExpiryNote({ license }) {
  if (!license.expiresAt) return <span style={{ color: 'var(--color-text-tertiary)' }}>No expiry</span>;
  if (license.isExpired) return <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Expired {new Date(license.expiresAt).toLocaleDateString()}</span>;
  return <span style={{ color: 'var(--color-text-tertiary)' }}>{license.daysRemaining} day{license.daysRemaining === 1 ? '' : 's'} left</span>;
}

/* Org Admin — read-only view of their own org's license and usage.
   (Super Admin manages licenses under Organizations > License & Limits instead.) */
function LicenseSelfPanel() {
  const [license, setLicense] = useState(null);
  const [error,   setError]   = useState('');

  useEffect(() => {
    api.get('/licenses/mine')
      .then(r => setLicense(r.data.license))
      .catch(e => setError(e.response?.data?.error || 'Failed to load license'));
  }, []);

  if (error) return <div style={{ padding: '20px', color: 'var(--danger)' }}>{error}</div>;
  if (!license) return <div style={{ padding: '20px', color: 'var(--color-text-tertiary)' }}>Loading…</div>;

  return (
    <div className="page fade-in">
      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
        Your organization's current plan and usage. Contact your Super Admin to upgrade.
      </div>
      <div style={{ maxWidth: 420, padding: '18px', background: 'var(--color-background-secondary)', borderRadius: '10px', border: '1px solid var(--color-border-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <PlanBadge plan={license.plan} />
          {license.isDisabled
            ? <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--danger)' }}>DISABLED</span>
            : license.isExpired
              ? <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--danger)' }}>EXPIRED</span>
              : <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}><ExpiryNote license={license} /></span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <UsageBar label="Users" used={license.userCount} max={license.maxUsers} />
          <UsageBar label="Projects" used={license.projectCount} max={license.maxProjects} />
        </div>
      </div>
    </div>
  );
}

export default function Settings({ page, theme, onThemeChange, user, projects, onNav, onDeleteProject }) {
  if (page === 'settings-org')      return <OrgAdministration user={user} projects={projects || []} onNav={onNav} onDeleteProject={onDeleteProject} />;
  if (page === 'settings-users')    return <UserManagementPanel user={user} projects={projects || []} />;
  if (page === 'settings-orgs')     return <OrganizationsAdmin user={user} />;
  if (page === 'settings-ai')       return <AIConfigPanel user={user} />;
  if (page === 'settings-smtp')     return <SMTPConfigPanel currentUser={user} />;
  if (page === 'settings-licenses') return <LicenseSelfPanel />;
  return null;
}
