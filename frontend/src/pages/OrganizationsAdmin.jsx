import { useState, useEffect } from 'react';
import api from '../api';
import CustomSelect from '../components/CustomSelect';
import Modal from '../components/Modal';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import ConfirmModal from '../components/ConfirmModal';
import SMTPConfigPanel from '../components/SMTPConfigPanel';

const PLAN_META = {
  trial:      { label: 'Trial',      color: '#d97706', bg: 'rgba(217,119,6,0.12)' },
  starter:    { label: 'Starter',    color: '#2563eb', bg: 'rgba(37,99,235,0.12)' },
  growth:     { label: 'Growth',     color: '#7c3aed', bg: 'rgba(124,58,237,0.12)' },
  business:   { label: 'Business',   color: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
  enterprise: { label: 'Enterprise', color: '#475569', bg: 'rgba(71,85,105,0.12)' },
};
const PLAN_ORDER = ['trial', 'starter', 'growth', 'business', 'enterprise'];
const INDUSTRIES = ['Technology', 'Finance', 'Healthcare', 'Retail', 'Education', 'Manufacturing', 'Other'];

function tabBtnStyle(active) {
  return {
    background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px', fontSize: '13px',
    fontWeight: active ? 600 : 400, color: active ? 'var(--accent)' : 'var(--color-text-secondary)',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent', marginBottom: '-1px',
  };
}

function PlanBadge({ plan }) {
  const meta = PLAN_META[plan] || { label: plan || '—', color: '#64748b', bg: 'rgba(100,116,139,0.12)' };
  return (
    <span style={{ padding: '2px 9px', borderRadius: '10px', fontSize: '11px', fontWeight: 700, letterSpacing: '.02em', textTransform: 'uppercase', background: meta.bg, color: meta.color }}>
      {meta.label}
    </span>
  );
}

function StatusPill({ status }) {
  const active = status === 'active';
  return (
    <span style={{ padding: '2px 9px', borderRadius: '10px', fontSize: '11px', fontWeight: 700, letterSpacing: '.02em', textTransform: 'uppercase', background: active ? 'rgba(22,163,74,0.12)' : 'rgba(239,68,68,0.12)', color: active ? '#16a34a' : '#ef4444' }}>
      {active ? 'Active' : 'Disabled'}
    </span>
  );
}

function Dot() {
  return <span style={{ margin: '0 8px', color: 'var(--color-text-tertiary)' }}>·</span>;
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

function StatCard({ icon, label, value }) {
  return (
    <div style={{ background: 'var(--color-background)', border: '1px solid var(--color-border-secondary)', borderRadius: '8px', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: '6px' }}>
        <i className={`ti ${icon}`} />{label}
      </div>
      <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--color-text-primary)' }}>{value}</div>
    </div>
  );
}

function ExpiryText({ license }) {
  if (!license?.expiresAt) return <span>No expiry</span>;
  if (license.isExpired) return <span style={{ color: 'var(--danger)' }}>Expired</span>;
  return <span>{license.daysRemaining}d left</span>;
}

function PlanCardPicker({ plans, value, onChange }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '12px' }}>
      {PLAN_ORDER.filter(p => plans[p]).map(p => {
        const meta = PLAN_META[p];
        const d = plans[p];
        const selected = value === p;
        return (
          <div key={p} onClick={() => onChange(p)} style={{
            position: 'relative', padding: '14px', borderRadius: '8px', cursor: 'pointer',
            border: selected ? '2px solid var(--accent)' : '1px solid var(--color-border-secondary)',
            background: 'var(--color-background-secondary)',
          }}>
            {selected && (
              <div style={{ position: 'absolute', top: 8, right: 8, width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="ti ti-check" style={{ fontSize: '11px' }} />
              </div>
            )}
            <PlanBadge plan={p} />
            <div style={{ marginTop: '8px', fontSize: '13px' }}>{d.maxUsers === null ? 'Unlimited' : d.maxUsers} users</div>
            <div style={{ fontSize: '13px' }}>{d.maxProjects === null ? 'Unlimited' : d.maxProjects} projects</div>
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--accent)' }}>{d.trialDays}-day trial</div>
          </div>
        );
      })}
    </div>
  );
}

/* ── New Organization modal ─────────────────────────────────────────────── */
function NewOrgModal({ plans, onClose, onCreated }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [industry, setIndustry] = useState('');
  const [plan, setPlan] = useState('trial');
  const [adminEmail, setAdminEmail] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) { toast('Organization name required', 'error'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/orgs', {
        name: name.trim(), description, website, industry, plan,
        admin_email: adminEmail.trim() || undefined,
        frontend_url: window.location.origin,
      });
      toast(`Organization "${data.org.name}" created`, 'success');
      if (data.invite?.ok === false) toast(data.invite.message || 'Admin invite failed', 'warn');
      else if (data.invite?.ok) toast(data.invite.email_sent ? 'Admin invite email sent' : 'Admin invite created — email not sent (SMTP not configured)', 'success');
      onCreated(data.org);
      onClose();
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to create organization', 'error');
    } finally { setSaving(false); }
  }

  return (
    <Modal onClose={onClose} style={{ maxWidth: 560, width: '92vw', maxHeight: '88vh', overflowY: 'auto' }}>
      <div className="modal-hdr">
        <div>
          <div className="modal-title">New Organization</div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', marginTop: '2px' }}>Fill in the details — admin will receive an invite email</div>
        </div>
        <button className="btn-icon" onClick={onClose}><i className="ti ti-x" /></button>
      </div>

      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '.05em', color: 'var(--color-text-tertiary)', margin: '4px 0 10px' }}>ORGANIZATION DETAILS</div>
      <div className="form-group">
        <label className="form-label">Organization Name *</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Acme Corp" autoFocus autoComplete="off" />
      </div>
      <div className="form-group">
        <label className="form-label">Description</label>
        <textarea value={description} onChange={e => setDescription(e.target.value.slice(0, 500))} placeholder="What does this organization do? (optional)" rows={3} />
        <div className="help-text" style={{ textAlign: 'right' }}>{description.length}/500</div>
      </div>
      <div style={{ display: 'flex', gap: '14px' }}>
        <div className="form-group" style={{ flex: 1 }}>
          <label className="form-label">Website</label>
          <input value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://acme.com" autoComplete="off" />
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label className="form-label">Industry</label>
          <CustomSelect value={industry} onChange={e => setIndustry(e.target.value)}>
            <option value="">Select industry...</option>
            {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
          </CustomSelect>
        </div>
      </div>

      <div className="separator" />
      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '.05em', color: 'var(--color-text-tertiary)', marginBottom: '10px' }}>INITIAL LICENSE PLAN</div>
      <PlanCardPicker plans={plans} value={plan} onChange={setPlan} />

      <div className="separator" />
      <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '.05em', color: 'var(--color-text-tertiary)', marginBottom: '6px' }}>ORGANIZATION ADMIN</div>
      <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '10px' }}>
        An invitation email will be sent to this address. The admin can register and manage users &amp; projects for this org.
      </div>
      <div className="form-group">
        <label className="form-label">Admin Email</label>
        <input value={adminEmail} onChange={e => setAdminEmail(e.target.value)} placeholder="orgadmin@company.com (optional)" autoComplete="off" />
        <div className="help-text">Leave blank to assign an admin later from the Org Admins tab.</div>
      </div>

      <div className="modal-footer">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={saving || !name.trim()}>
          {saving ? <span className="spinner" /> : <i className="ti ti-plus" />} Create Organization
        </button>
      </div>
    </Modal>
  );
}

/* ── Overview tab ────────────────────────────────────────────────────────── */
function OrgOverviewTab({ org, license }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '14px' }}>
        <StatCard icon="ti-users" label="Members" value={org.member_count || 0} />
        <StatCard icon="ti-folder" label="Projects" value={org.project_count || 0} />
        <StatCard icon="ti-mail" label="Pending Invites" value={org.pending_invites || 0} />
        <StatCard icon="ti-calendar" label="Created" value={new Date(org.created_at).toLocaleDateString()} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
        <StatCard icon="ti-key" label="Plan" value={<PlanBadge plan={license?.plan} />} />
        <StatCard icon="ti-user" label="User Limit" value={`${license?.userCount ?? 0} / ${license?.maxUsers ?? '∞'}`} />
        <StatCard icon="ti-chart-bar" label="Project Limit" value={`${license?.projectCount ?? 0} / ${license?.maxProjects ?? '∞'}`} />
        <StatCard icon="ti-hourglass" label="License Expires" value={license ? <ExpiryText license={license} /> : '—'} />
      </div>
    </div>
  );
}

/* ── Edit Details tab ────────────────────────────────────────────────────── */
function OrgEditDetailsTab({ org, onSaved }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: org.name, description: org.description || '', website: org.website || '', industry: org.industry || '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({ name: org.name, description: org.description || '', website: org.website || '', industry: org.industry || '' });
  }, [org.id]);

  async function save() {
    if (!form.name.trim()) { toast('Name required', 'error'); return; }
    setSaving(true);
    try {
      await api.put(`/orgs/${org.id}`, form);
      toast('Organization updated', 'success');
      onSaved({ ...org, ...form });
    } catch (e) {
      toast(e.response?.data?.error || 'Update failed', 'error');
    } finally { setSaving(false); }
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '14px' }}>Edit Organization Details</div>
      <div className="form-group">
        <label className="form-label">Organization Name *</label>
        <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoComplete="off" />
      </div>
      <div className="form-group">
        <label className="form-label">Description</label>
        <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value.slice(0, 500) }))} rows={3} />
        <div className="help-text" style={{ textAlign: 'right' }}>{form.description.length}/500</div>
      </div>
      <div style={{ display: 'flex', gap: '14px' }}>
        <div className="form-group" style={{ flex: 1 }}>
          <label className="form-label">Website</label>
          <input value={form.website} onChange={e => setForm(f => ({ ...f, website: e.target.value }))} placeholder="https://acme.com" autoComplete="off" />
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label className="form-label">Industry</label>
          <CustomSelect value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))}>
            <option value="">Select industry...</option>
            {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
          </CustomSelect>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : <i className="ti ti-check" />} Save Changes
        </button>
        <button className="btn-secondary" onClick={() => setForm({ name: org.name, description: org.description || '', website: org.website || '', industry: org.industry || '' })}>Reset</button>
      </div>
    </div>
  );
}

/* ── License & Limits tab ────────────────────────────────────────────────── */
function OrgLicenseTab({ org, license, plans, onChanged }) {
  const { toast } = useToast();
  const [draftPlan, setDraftPlan] = useState(license?.plan || 'trial');
  const [draftExpiry, setDraftExpiry] = useState(license?.expiresAt ? license.expiresAt.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraftPlan(license?.plan || 'trial');
    setDraftExpiry(license?.expiresAt ? license.expiresAt.slice(0, 10) : '');
  }, [org.id, license?.plan, license?.expiresAt]);

  async function save() {
    setSaving(true);
    try {
      const body = { plan: draftPlan };
      if (draftExpiry) body.expiresAt = new Date(draftExpiry).toISOString();
      const { data } = await api.put(`/licenses/${org.id}`, body);
      toast('License updated', 'success');
      onChanged(data.license);
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to update license', 'error');
    } finally { setSaving(false); }
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard icon="ti-key" label="Plan" value={<PlanBadge plan={license?.plan} />} />
        <StatCard icon="ti-users" label="Users" value={`${license?.userCount ?? 0} / ${license?.maxUsers ?? '∞'}`} />
        <StatCard icon="ti-folder" label="Projects" value={`${license?.projectCount ?? 0} / ${license?.maxProjects ?? '∞'}`} />
        <StatCard icon="ti-hourglass" label="Expires" value={license ? <ExpiryText license={license} /> : '—'} />
      </div>

      <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '12px' }}>Change plan</div>
      <PlanCardPicker plans={plans} value={draftPlan} onChange={setDraftPlan} />

      <div style={{ marginTop: '20px', padding: '16px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '8px' }}>
        <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '10px' }}>License Expiry Date</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <input type="date" value={draftExpiry} onChange={e => setDraftExpiry(e.target.value)} style={{ maxWidth: '180px' }} />
          <button onClick={() => setDraftExpiry('')} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
            Clear (use plan default)
          </button>
          {!draftExpiry && (
            <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>
              Will use the {PLAN_META[draftPlan]?.label} plan's default trial window from today
            </span>
          )}
        </div>
      </div>

      <button className="btn-primary" onClick={save} disabled={saving} style={{ marginTop: '16px' }}>
        {saving ? <span className="spinner" /> : <i className="ti ti-check" />} Save License
      </button>
    </div>
  );
}

/* ── Org Admins tab ──────────────────────────────────────────────────────── */
function OrgAdminsTab({ org, user, onInviteSent }) {
  const { toast } = useToast();
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const [admins, setAdmins] = useState(null);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  const [invites, setInvites] = useState([]);
  const [revealedInvite, setRevealedInvite] = useState(null);

  function load() {
    api.get(`/orgs/${org.id}/admins`).then(r => setAdmins(r.data.admins || [])).catch(() => setAdmins([]));
    // GET /invites returns platform-wide invites for a super admin — filter to this org client-side.
    api.get('/invites').then(r => setInvites((r.data.invites || []).filter(i => i.org_id === org.id))).catch(() => setInvites([]));
  }
  useEffect(load, [org.id]);

  async function sendInvite() {
    if (!email.trim()) return;
    setSending(true); setInviteResult(null);
    try {
      const { data } = await api.post('/invites', { email: email.trim(), role: 'org_admin', org_id: org.id, frontend_url: window.location.origin });
      setInviteResult({ ok: true, url: data.invite_url, emailSent: data.email_sent });
      toast(data.email_sent ? `Invite sent to ${email}` : 'Invite created — email not sent (SMTP not configured)', 'success');
      setEmail('');
      onInviteSent?.();
      load();
    } catch (e) {
      toast(e.response?.data?.error || e.response?.data?.message || 'Failed to send invite', 'error');
    } finally { setSending(false); }
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

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '10px' }}>SMTP configuration</div>
      <div style={{ marginBottom: '20px' }}>
        <SMTPConfigPanel currentUser={user} showHelp={false} standalone={false} />
      </div>

      <div style={{ padding: '16px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '8px', marginBottom: '16px' }}>
        <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '6px' }}>Invite org admin</div>
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
          An invite email will be sent. The recipient can register and manage this org's users and projects. Works whether or not they already have an account.
        </div>
        <div style={{ display: 'flex', gap: '10px', marginBottom: inviteResult ? '14px' : 0 }}>
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@company.com" style={{ flex: 1 }}
            autoComplete="off" onKeyDown={e => e.key === 'Enter' && sendInvite()} />
          <button className="btn-primary" onClick={sendInvite} disabled={sending || !email.trim()}>
            {sending ? <span className="spinner" /> : <i className="ti ti-send" />} Send Invite
          </button>
        </div>
        {inviteResult?.ok && inviteResult.url && (
          <div style={{ padding: '10px 12px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '8px' }}>
            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
              <i className="ti ti-link" style={{ marginRight: 4 }} />
              Share this invite link with the admin:
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input readOnly value={inviteResult.url} onClick={e => e.target.select()}
                style={{ flex: 1, padding: '6px 8px', fontSize: '11px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '6px', color: 'var(--accent)' }} />
              <button className="btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(inviteResult.url); toast('Invite link copied!', 'success'); }}>
                <i className="ti ti-copy" /> Copy
              </button>
            </div>
            {!inviteResult.emailSent && (
              <div style={{ marginTop: 8, fontSize: '11px', color: 'var(--warn)' }}>
                <i className="ti ti-mail-off" style={{ marginRight: 4 }} />
                Email not sent (SMTP not configured) — share the link above directly.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: '16px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>Current admins</div>
          <span style={{ background: 'var(--color-background)', borderRadius: '10px', padding: '1px 8px', fontSize: '11px', fontWeight: 600 }}>{admins?.length || 0}</span>
        </div>
        {admins === null ? (
          <div style={{ color: 'var(--color-text-tertiary)', fontSize: '12px' }}>Loading…</div>
        ) : admins.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--color-text-tertiary)', fontSize: '12px' }}>No org admins assigned. Invite one above.</div>
        ) : admins.map(a => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--color-border-secondary)' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, flexShrink: 0 }}>
              {a.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 600 }}>{a.name}</div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{a.email}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: '16px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '8px', marginTop: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 600, fontSize: '14px' }}>Invites</div>
            <span style={{ background: 'var(--color-background)', borderRadius: '10px', padding: '1px 8px', fontSize: '11px', fontWeight: 600 }}>{invites.length}</span>
          </div>
          {invites.length > 0 && (
            <button onClick={deleteAllInvites} style={{ background: 'none', border: 'none', color: 'var(--danger)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
              Delete all
            </button>
          )}
        </div>
        {invites.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--color-text-tertiary)', fontSize: '12px' }}>No invites yet.</div>
        ) : invites.map(inv => (
          <div key={inv.id} style={{ padding: '10px 12px', background: 'var(--color-background)', borderRadius: '8px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '13px' }}>{inv.email}</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{inv.role === 'org_admin' ? 'Org Admin' : 'User'}</div>
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
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: '8px' }}>
                <input readOnly value={`${window.location.origin}/accept-invite/${inv.token}`} onClick={e => e.target.select()}
                  style={{ flex: 1, padding: '5px 8px', fontSize: '11px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '6px', color: 'var(--accent)' }} />
                <button className="btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/accept-invite/${inv.token}`); toast('Link copied!', 'success'); }}>
                  Copy
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
    </div>
  );
}

/* ── Registry Token tab ──────────────────────────────────────────────────── */
function OrgRegistryTokenTab({ org }) {
  const { toast } = useToast();
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const [meta, setMeta] = useState(null);
  const [expiry, setExpiry] = useState('');
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revealed, setRevealed] = useState(null);

  function load() {
    api.get(`/orgs/${org.id}/npm-token`).then(r => setMeta(r.data)).catch(() => setMeta(null));
  }
  useEffect(() => { setRevealed(null); load(); }, [org.id]);

  async function generate() {
    setGenerating(true);
    try {
      const body = {};
      if (expiry) body.expiresAt = new Date(expiry).toISOString();
      const { data } = await api.post(`/orgs/${org.id}/npm-token`, body);
      setRevealed(data.token);
      setMeta({ hasToken: true, prefix: data.prefix, createdAt: data.createdAt, expiresAt: data.expiresAt });
      toast('Registry token generated', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to generate registry token', 'error');
    } finally { setGenerating(false); }
  }

  async function revoke() {
    const ok = await confirm(`Revoke the registry token for "${org.name}"? All members lose access to @peako packages until a new one is generated.`, 'Revoke Registry Token');
    if (!ok) return;
    setRevoking(true);
    try {
      await api.delete(`/orgs/${org.id}/npm-token`);
      setMeta({ hasToken: false, prefix: null, createdAt: null, expiresAt: null });
      setRevealed(null);
      toast('Registry token revoked', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to revoke registry token', 'error');
    } finally { setRevoking(false); }
  }

  if (meta === null) return <div style={{ color: 'var(--color-text-tertiary)', fontSize: '12px' }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />

      {meta.hasToken && (
        <div className="card">
          <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '14px' }}>Current Token</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '16px' }}>
            <StatCard icon="ti-key" label="Token Prefix" value={`${meta.prefix}…`} />
            <StatCard icon="ti-calendar" label="Created" value={new Date(meta.createdAt).toLocaleDateString()} />
            <StatCard icon="ti-hourglass" label="Expires" value={meta.expiresAt ? new Date(meta.expiresAt).toLocaleDateString() : 'Never'} />
          </div>
          <button onClick={revoke} disabled={revoking} style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444',
            borderRadius: '8px', padding: '9px 18px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
          }}>
            {revoking ? <span className="spinner" /> : null} Revoke Token
          </button>
        </div>
      )}

      {revealed && (
        <div className="card" style={{ background: 'rgba(34,197,94,0.05)', borderColor: 'rgba(34,197,94,0.3)' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px' }}>
            <i className="ti ti-alert-circle" style={{ marginRight: 6, color: '#16a34a' }} />
            Copy this token now — it won't be shown again here
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: '10px' }}>
            <input readOnly value={revealed} onClick={e => e.target.select()}
              style={{ flex: 1, padding: '6px 8px', fontSize: '11px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '6px' }} />
            <button className="btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(revealed); toast('Token copied', 'success'); }}>
              <i className="ti ti-copy" /> Copy
            </button>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginBottom: 4 }}>.npmrc:</div>
          <code style={{ display: 'block', fontSize: '11px', padding: '8px 10px', background: 'var(--color-background)', borderRadius: '6px', overflowX: 'auto' }}>
            @peako:registry=https://artifact-keeper.qtsolvdev.com/npm/qa-automation-libraries/{'\n'}//artifact-keeper.qtsolvdev.com/npm/qa-automation-libraries/:_authToken={revealed}
          </code>
        </div>
      )}

      <div className="card">
        <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '4px' }}>{meta.hasToken ? 'Generate New Token' : 'Generate Token'}</div>
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '18px' }}>
          {meta.hasToken ? 'Generating a new token immediately revokes the existing one.' : 'No registry token has been generated for this organization yet.'}
        </div>
        <label className="form-label" style={{ display: 'block', marginBottom: '6px' }}>
          Expiry Date <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>(optional)</span>
        </label>
        <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={{ maxWidth: '220px', marginBottom: '16px' }} />
        <div>
          <button className="btn-primary" onClick={generate} disabled={generating}>
            {generating ? <span className="spinner" /> : null} {meta.hasToken ? 'Regenerate Token' : 'Generate Token'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── All Users tab (platform-wide, super_admin only) ────────────────────── */
const th = { textAlign: 'left', padding: '8px 12px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-tertiary)', fontWeight: 600 };
const td = { padding: '8px 12px', fontSize: '13px' };

function AllUsersTab() {
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const { toast } = useToast();
  const [users, setUsers] = useState(null);
  const [actionLoading, setActionLoading] = useState({});

  function load() {
    api.get('/admin/users').then(r => setUsers(r.data.users || [])).catch(() => setUsers([]));
  }
  useEffect(load, []);

  async function setStatus(id, status) {
    setActionLoading(a => ({ ...a, [id]: true }));
    try {
      await api.put(`/admin/users/${id}/status`, { status });
      setUsers(u => u.map(x => x.id === id ? { ...x, status } : x));
      toast(status === 'active' ? 'User activated' : 'User deactivated', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Action failed', 'error');
    } finally { setActionLoading(a => ({ ...a, [id]: false })); }
  }

  async function removeUser(id) {
    const u = users.find(x => x.id === id);
    const ok = await confirm(`Remove "${u?.name || 'this user'}" permanently? This cannot be undone.`, 'Remove User');
    if (!ok) return;
    setUsers(prev => prev.filter(x => x.id !== id));
    try {
      await api.delete(`/admin/users/${id}`);
      toast(`"${u?.name || 'User'}" removed`, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Delete failed', 'error');
      load();
    }
  }

  if (users === null) return <div style={{ padding: '20px', color: 'var(--color-text-tertiary)' }}>Loading…</div>;

  return (
    <div>
      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      {users.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-tertiary)' }}>No users yet.</div>
      ) : (
        <div style={{ border: '1px solid var(--color-border-secondary)', borderRadius: '8px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--color-background-secondary)' }}>
                <th style={th}>Name</th><th style={th}>Email</th><th style={th}>Role</th><th style={th}>Organization</th><th style={th}>Status</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--color-border-secondary)' }}>
                  <td style={td}>{u.name}</td>
                  <td style={td}>{u.email}</td>
                  <td style={td}><span style={{ textTransform: 'capitalize' }}>{u.role.replace('_', ' ')}</span></td>
                  <td style={td}>{u.org_name || '—'}</td>
                  <td style={td}><StatusPill status={u.status} /></td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn-secondary btn-sm" disabled={actionLoading[u.id]} onClick={() => setStatus(u.id, u.status === 'active' ? 'rejected' : 'active')}>
                      {u.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)', marginLeft: '6px' }} onClick={() => removeUser(u.id)}>
                      <i className="ti ti-trash" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Top-level: Platform Administration ─────────────────────────────────── */
export default function OrganizationsAdmin({ user }) {
  const { toast } = useToast();
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const [orgs, setOrgs] = useState(null);
  const [licenses, setLicenses] = useState({});
  const [plans, setPlans] = useState(null);
  const [allUsersCount, setAllUsersCount] = useState(0);
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [subTab, setSubTab] = useState('overview');
  const [topTab, setTopTab] = useState('orgs');
  const [search, setSearch] = useState('');
  const [showNewOrg, setShowNewOrg] = useState(false);

  function loadAll() {
    Promise.all([
      api.get('/orgs/managed').catch(() => ({ data: { orgs: [] } })),
      api.get('/licenses').catch(() => ({ data: { licenses: [] } })),
      api.get('/admin/users').catch(() => ({ data: { users: [] } })),
      api.get('/licenses/plans').catch(() => ({ data: { plans: {} } })),
    ]).then(([orgsRes, licRes, usersRes, plansRes]) => {
      setOrgs(orgsRes.data.orgs || []);
      const map = {};
      (licRes.data.licenses || []).forEach(l => { map[l.org.id] = l.license; });
      setLicenses(map);
      setAllUsersCount((usersRes.data.users || []).length);
      setPlans(plansRes.data.plans || {});
    });
  }
  useEffect(loadAll, []);

  useEffect(() => {
    if (orgs && orgs.length && selectedOrgId === null) setSelectedOrgId(orgs[0].id);
  }, [orgs]);

  const selectedOrg = orgs?.find(o => o.id === selectedOrgId) || null;
  const selectedLicense = selectedOrgId ? licenses[selectedOrgId] : null;

  const planCounts = { trial: 0, starter: 0, growth: 0, business: 0, enterprise: 0 };
  Object.values(licenses).forEach(l => { if (l && planCounts[l.plan] !== undefined) planCounts[l.plan]++; });

  const filteredOrgs = (orgs || []).filter(o => o.name.toLowerCase().includes(search.toLowerCase()));

  async function toggleDisable() {
    if (!selectedOrg || !selectedLicense) return;
    const next = selectedLicense.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled') {
      const ok = await confirm(`Disable "${selectedOrg.name}"? All its users will be blocked from accessing Peako until re-enabled.`, 'Disable Organization');
      if (!ok) return;
    }
    try {
      const { data } = await api.put(`/licenses/${selectedOrg.id}/status`, { status: next });
      setLicenses(prev => ({ ...prev, [selectedOrg.id]: data.license }));
      toast(next === 'active' ? `${selectedOrg.name} enabled` : `${selectedOrg.name} disabled`, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to update status', 'error');
    }
  }

  if (orgs === null || plans === null) return <div style={{ padding: '24px', color: 'var(--color-text-tertiary)' }}>Loading…</div>;

  return (
    <div className="page fade-in" style={{ background: '#ffffff', minHeight: '100vh', '--color-text-tertiary': '#475569' }}>
      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '18px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <span style={{ display: 'inline-block', fontSize: '10px', fontWeight: 700, letterSpacing: '.05em', color: 'var(--accent)', background: 'rgba(0,0,0,0.05)', padding: '3px 8px', borderRadius: '10px' }}>SUPER ADMIN</span>
          <h2 style={{ margin: '8px 0 4px', fontSize: '22px' }}>Platform Administration</h2>
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>Manage organizations, licenses, and platform users</div>
        </div>
        <button className="btn-primary" onClick={() => setShowNewOrg(true)}><i className="ti ti-plus" /> New Organization</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '10px', marginBottom: '20px' }}>
        <StatCard icon="ti-building" label="Total Orgs" value={orgs.length} />
        <StatCard icon="ti-users" label="Total Users" value={allUsersCount} />
        {PLAN_ORDER.map(p => (
          <StatCard key={p} icon="ti-key" label={PLAN_META[p].label} value={planCounts[p]} />
        ))}
      </div>

      <div style={{ display: 'flex', gap: '2px', marginBottom: '18px', borderBottom: '1px solid var(--color-border-secondary)' }}>
        <button onClick={() => setTopTab('orgs')} style={tabBtnStyle(topTab === 'orgs')}>Organizations ({orgs.length})</button>
        <button onClick={() => setTopTab('users')} style={tabBtnStyle(topTab === 'users')}>All Users ({allUsersCount})</button>
      </div>

      {topTab === 'users' ? <AllUsersTab /> : (
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
          <div style={{ width: '280px', flexShrink: 0, background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '8px', padding: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>Organizations</div>
              <span style={{ background: 'var(--color-background)', borderRadius: '10px', padding: '1px 8px', fontSize: '11px', fontWeight: 600 }}>{orgs.length}</span>
            </div>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search organizations..." style={{ width: '100%', marginBottom: '10px' }} autoComplete="off" />
            {filteredOrgs.map(o => (
              <div key={o.id} onClick={() => { setSelectedOrgId(o.id); setSubTab('overview'); }} style={{
                display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '6px', cursor: 'pointer', marginBottom: '4px',
                background: o.id === selectedOrgId ? 'var(--color-background)' : 'transparent',
                border: o.id === selectedOrgId ? '1px solid var(--accent)' : '1px solid transparent',
              }}>
                <div style={{ width: 30, height: 30, borderRadius: '8px', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '13px', flexShrink: 0 }}>
                  {o.name[0]?.toUpperCase()}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{o.member_count || 0} users · {o.project_count || 0} projects</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {!selectedOrg ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--color-text-tertiary)' }}>Select an organization, or create one.</div>
            ) : (
              <>
                <div style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '8px', padding: '16px', marginBottom: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <div style={{ width: 48, height: 48, borderRadius: '10px', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '18px', flexShrink: 0 }}>
                      {selectedOrg.name[0]?.toUpperCase()}
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: '17px' }}>{selectedOrg.name}</span>
                        <StatusPill status={selectedLicense?.status} />
                        {selectedLicense && <PlanBadge plan={selectedLicense.plan} />}
                      </div>
                      {selectedOrg.description && <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '10px', lineHeight: 1.5 }}>{selectedOrg.description}</div>}
                      <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span>/{selectedOrg.slug}</span>
                        <Dot />
                        <span>{selectedOrg.member_count || 0} members</span>
                        <Dot />
                        <span>{selectedOrg.project_count || 0} projects</span>
                        {selectedOrg.industry && (<><Dot /><span>{selectedOrg.industry}</span></>)}
                        {selectedOrg.website && (
                          <><Dot /><a href={selectedOrg.website} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{selectedOrg.website}</a></>
                        )}
                      </div>
                    </div>
                  </div>
                  <button onClick={toggleDisable} style={{
                    background: '#fff', border: `1px solid ${selectedLicense?.status === 'disabled' ? 'var(--accent)' : 'var(--danger)'}`,
                    color: selectedLicense?.status === 'disabled' ? 'var(--accent)' : 'var(--danger)',
                    borderRadius: '6px', padding: '6px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                  }}>
                    {selectedLicense?.status === 'disabled' ? 'Enable Org' : 'Disable Org'}
                  </button>
                </div>

                <div style={{ display: 'flex', gap: '2px', marginBottom: '16px', borderBottom: '1px solid var(--color-border-secondary)' }}>
                  {[
                    { id: 'overview', label: 'Overview' },
                    { id: 'edit', label: 'Edit Details' },
                    { id: 'license', label: 'License & Limits' },
                    { id: 'admins', label: 'Org Admins' },
                    { id: 'registry', label: 'Registry Token' },
                  ].map(t => (
                    <button key={t.id} onClick={() => setSubTab(t.id)} style={tabBtnStyle(subTab === t.id)}>{t.label}</button>
                  ))}
                </div>

                {subTab === 'overview' && <OrgOverviewTab org={selectedOrg} license={selectedLicense} />}
                {subTab === 'edit' && (
                  <OrgEditDetailsTab org={selectedOrg} onSaved={updated => setOrgs(prev => prev.map(o => o.id === updated.id ? { ...o, ...updated } : o))} />
                )}
                {subTab === 'license' && (
                  <OrgLicenseTab org={selectedOrg} license={selectedLicense} plans={plans}
                    onChanged={lic => setLicenses(prev => ({ ...prev, [selectedOrg.id]: lic }))} />
                )}
                {subTab === 'admins' && <OrgAdminsTab org={selectedOrg} user={user} onInviteSent={loadAll} />}
                {subTab === 'registry' && <OrgRegistryTokenTab org={selectedOrg} />}
              </>
            )}
          </div>
        </div>
      )}

      {showNewOrg && <NewOrgModal plans={plans} onClose={() => setShowNewOrg(false)} onCreated={() => loadAll()} />}
    </div>
  );
}
