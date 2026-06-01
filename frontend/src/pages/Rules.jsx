import { useState, useEffect, useRef } from 'react';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import { useConfirm } from '../hooks/useConfirm';
import CustomSelect from '../components/CustomSelect';
import api from '../api';

const METRICS = ['Response Time','Error Rate','Throughput','Latency P95','Latency P99','CPU Usage','Memory Usage'];
const OPERATORS = ['<','>','<=','>=','='];
const UNITS = ['ms','s','%','req/s','MB','KB'];

const DEFAULT_FORM = { metric: METRICS[0], operator: '<', value: '500', unit: 'ms', severity: 'error' };

export default function Rules({ project, collection, onNav, onProjectUpdated, openModalTrigger }) {
  const [modal, setModal] = useState(null); // null | 'add' | ruleObj
  const [form, setForm] = useState(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const firstRender = useRef(true);
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (openModalTrigger > 0) { setForm(DEFAULT_FORM); setModal('add'); }
  }, [openModalTrigger]);

  if (!project) return <div className="page"><div className="empty"><i className="ti ti-folder-off" /><div className="empty-title">Select a project first</div></div></div>;

  function openEdit(r) {
    setForm({ metric: r.metric, operator: r.operator, value: r.value, unit: r.unit, severity: r.severity });
    setModal(r);
  }

  async function save() {
    setSaving(true);
    try {
      if (modal === 'add') {
        await api.post(`/projects/${project.id}/rules`, form);
      } else {
        await api.put(`/projects/${project.id}/rules/${modal.id}`, form);
      }
      await onProjectUpdated();
      setModal(null);
    } finally { setSaving(false); }
  }

  async function del(id) {
    const rule = p?.rules?.find(r => r.id === id);
    const ok = await confirm(
      `Delete the rule "${rule?.metric || 'this rule'}" (${rule?.operator || ''} ${rule?.value || ''} ${rule?.unit || ''})? This cannot be undone.`,
      'Delete Rule'
    );
    if (!ok) return;
    await api.delete(`/projects/${project.id}/rules/${id}`);
    onProjectUpdated();
  }

  const p = project;
  return (
    <div className="page fade-in">
      <div className="breadcrumb">
        <a onClick={() => onNav('dashboard')}><i className="ti ti-layout-dashboard" style={{ fontSize: '12px', marginRight: '4px' }} />Dashboard</a>
        <i className="ti ti-chevron-right" style={{ fontSize: '12px' }} />
        <a onClick={() => onNav('project-home')}><i className="ti ti-folder" style={{ fontSize: '12px', marginRight: '4px' }} />{p.name}</a>
        <i className="ti ti-chevron-right" style={{ fontSize: '12px' }} />
        <span><i className="ti ti-adjustments-horizontal" style={{ fontSize: '12px', marginRight: '4px' }} />Rule Engine</span>
      </div>

      <div style={{ marginBottom: '16px', padding: '14px 16px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid var(--accent)' }}>
        <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}><i className="ti ti-adjustments-horizontal" style={{ marginRight: '7px', color: 'var(--accent)' }} />Performance Configuration Rules</div>
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Define thresholds and constraints for your collections. Rules are applied during script generation to set pass/fail criteria.</div>
      </div>

      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 130px 80px 120px', gap: '8px', padding: '0 0 8px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text-secondary)' }}>
          <div>Metric</div><div>Operator</div><div>Threshold</div><div>Severity</div><div>Actions</div>
        </div>
        {p.rules?.length ? p.rules.map(r => (
          <div className="rule-row" key={r.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <i className="ti ti-chart-line" style={{ color: 'var(--accent)', fontSize: '15px' }} />
              <div>
                <div style={{ fontWeight: 500, fontSize: '13.5px' }}>{r.metric}</div>
                <span className={`badge ${r.severity === 'error' ? 'tag-red' : 'tag-amber'}`}>{r.severity}</span>
              </div>
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: '15px', fontWeight: 600, textAlign: 'center' }}>{r.operator}</div>
            <div style={{ fontWeight: 600 }}>{r.value} <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>{r.unit}</span></div>
            <div><span className={`badge ${r.severity === 'error' ? 'tag-red' : 'tag-amber'}`}>{r.severity}</span></div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button className="btn-icon" onClick={() => openEdit(r)}><i className="ti ti-edit" style={{ fontSize: '14px' }} /></button>
              <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)', borderColor: 'rgba(247,84,100,0.3)' }} onClick={() => del(r.id)}><i className="ti ti-trash" /> Delete</button>
            </div>
          </div>
        )) : (
          <div className="empty" style={{ padding: '24px' }}>
            <i className="ti ti-adjustments-horizontal" />
            <div className="empty-title">No rules configured</div>
          </div>
        )}
      </div>

      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />

      {modal && (
        <Modal onClose={() => setModal(null)}>
          <div className="modal-hdr">
            <div className="modal-title">{modal === 'add' ? 'Add' : 'Edit'} Performance Rule</div>
            <button className="btn-icon" onClick={() => setModal(null)}><i className="ti ti-x" /></button>
          </div>
          <div className="form-group"><label className="form-label">Metric</label>
            <CustomSelect value={form.metric} onChange={e => setForm(f => ({ ...f, metric: e.target.value }))}>
              {METRICS.map(m => <option key={m}>{m}</option>)}
            </CustomSelect>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
            <div className="form-group"><label className="form-label">Operator</label>
              <CustomSelect value={form.operator} onChange={e => setForm(f => ({ ...f, operator: e.target.value }))}>
                {OPERATORS.map(o => <option key={o}>{o}</option>)}
              </CustomSelect>
            </div>
            <div className="form-group"><label className="form-label">Value</label>
              <input type="number" value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} />
            </div>
            <div className="form-group"><label className="form-label">Unit</label>
              <CustomSelect value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}>
                {UNITS.map(u => <option key={u}>{u}</option>)}
              </CustomSelect>
            </div>
          </div>
          <div className="form-group"><label className="form-label">Severity</label>
            <CustomSelect value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value }))}>
              <option value="error">Error (fail test)</option>
              <option value="warning">Warning (alert only)</option>
            </CustomSelect>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>{saving && <span className="spinner" />}{modal === 'add' ? 'Add Rule' : 'Save Changes'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
