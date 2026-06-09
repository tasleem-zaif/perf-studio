import { useState, useEffect, useRef } from 'react';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import { useConfirm } from '../hooks/useConfirm';
import CustomSelect from '../components/CustomSelect';
import api from '../api';

// ── Metric config — drives operator list and unit automatically ───────────────
const METRIC_CONFIG = {
  'Response Time': { unit: 'ms',    operators: ['>','>=','<','<=','between'], min: 0, max: 30000, step: 50  },
  'Error Rate':    { unit: '%',     operators: ['>','>=','between'],          min: 0, max: 100,   step: 1   },
  'Throughput':    { unit: 'req/s', operators: ['<','<=','between'],          min: 0, max: 100000, step: 10 },
  'Latency P95':   { unit: 'ms',    operators: ['>','>=','<','<=','between'], min: 0, max: 30000, step: 50  },
  'Latency P99':   { unit: 'ms',    operators: ['>','>=','<','<=','between'], min: 0, max: 30000, step: 100 },
  'CPU Usage':     { unit: '%',     operators: ['>','>=','between'],          min: 0, max: 100,   step: 5   },
  'Memory Usage':  { unit: '%',     operators: ['>','>=','between'],          min: 0, max: 100,   step: 5   },
};

const METRICS = Object.keys(METRIC_CONFIG);

const OPERATOR_LABELS = {
  '>':       '> Greater than',
  '>=':      '≥ Greater than or equal',
  '<':       '< Less than',
  '<=':      '≤ Less than or equal',
  'between': '↔ Between (range)',
};

function makeDefault(metric = 'Response Time') {
  const cfg = METRIC_CONFIG[metric];
  return { metric, operator: cfg.operators[0], value: '', value_min: '', value_max: '', unit: cfg.unit, severity: 'error' };
}

function ruleLabel(r) {
  if (r.operator === 'between') return `between ${r.value_min} – ${r.value_max} ${r.unit}`;
  const sym = { '>=': '≥', '<=': '≤' }[r.operator] || r.operator;
  return `${sym} ${r.value} ${r.unit}`;
}

// ── Conflict / collision detection ───────────────────────────────────────────
// Converts a rule into a numeric [lo, hi] range for overlap comparison.
// Open-ended operators use ±Infinity; strict inequalities shift by epsilon.
const EPS = 0.0001;
function ruleToRange(rule) {
  const v    = parseFloat(rule.value);
  const vMin = parseFloat(rule.value_min);
  const vMax = parseFloat(rule.value_max);
  switch (rule.operator) {
    case '>':       return isNaN(v)            ? null : [v + EPS,  Infinity];
    case '>=':      return isNaN(v)            ? null : [v,        Infinity];
    case '<':       return isNaN(v)            ? null : [-Infinity, v - EPS];
    case '<=':      return isNaN(v)            ? null : [-Infinity, v];
    case '=':       return isNaN(v)            ? null : [v,        v];
    case 'between': return (isNaN(vMin) || isNaN(vMax)) ? null : [vMin, vMax];
    default:        return null;
  }
}

function rangesOverlap([lo1, hi1], [lo2, hi2]) {
  return lo1 <= hi2 && lo2 <= hi1;
}

// Returns existing rules that overlap with the given form values (same metric).
function findConflicts(form, existingRules, editingId) {
  const newRange = ruleToRange(form);
  if (!newRange) return []; // form not fully filled yet — no conflict check
  return (existingRules || []).filter(r => {
    if (r.id === editingId) return false;            // skip rule being edited
    if (r.metric !== form.metric) return false;      // different metric
    const range = ruleToRange(r);
    if (!range) return false;
    return rangesOverlap(newRange, range);
  });
}

export default function Rules({ project, onProjectUpdated, openModalTrigger }) {
  const [modal,  setModal]  = useState(null);
  const [form,   setForm]   = useState(makeDefault());
  const [saving, setSaving] = useState(false);
  const firstRender = useRef(true);
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (openModalTrigger > 0) { setForm(makeDefault()); setModal('add'); }
  }, [openModalTrigger]);

  if (!project) return (
    <div className="page"><div className="empty"><i className="ti ti-folder-off"/><div className="empty-title">Select a project first</div></div></div>
  );

  function handleMetricChange(metric) {
    const cfg = METRIC_CONFIG[metric];
    setForm(f => ({ ...f, metric, operator: cfg.operators[0], unit: cfg.unit, value: '', value_min: '', value_max: '' }));
  }

  function handleOperatorChange(operator) {
    setForm(f => ({ ...f, operator, value: '', value_min: '', value_max: '' }));
  }

  function openEdit(r) {
    setForm({ metric: r.metric, operator: r.operator, value: r.value || '', value_min: r.value_min || '', value_max: r.value_max || '', unit: r.unit, severity: r.severity });
    setModal(r);
  }

  async function save() {
    // ── Basic validation ──────────────────────────────────────────────────────
    if (form.operator === 'between') {
      if (!form.value_min || !form.value_max) return alert('Enter both From and To values for the range.');
      if (Number(form.value_min) >= Number(form.value_max)) return alert('From value must be less than To value.');
    } else {
      if (form.value === '') return alert('Enter a threshold value.');
    }

    // ── Conflict check — block save if any overlapping rule exists ───────────
    const editingId = modal === 'add' ? null : modal?.id;
    const conflicts = findConflicts(form, project?.rules, editingId);
    if (conflicts.length > 0) return; // blocked — UI already shows the error

    setSaving(true);
    try {
      const cfg = METRIC_CONFIG[form.metric];
      const payload = {
        metric:    form.metric,
        operator:  form.operator,
        value:     form.operator === 'between' ? '' : String(form.value),
        value_min: form.operator === 'between' ? String(form.value_min) : null,
        value_max: form.operator === 'between' ? String(form.value_max) : null,
        unit:      cfg.unit,
        severity:  form.severity,
      };
      if (modal === 'add') await api.post(`/projects/${project.id}/rules`, payload);
      else                 await api.put(`/projects/${project.id}/rules/${modal.id}`, payload);
      await onProjectUpdated();
      setModal(null);
    } finally { setSaving(false); }
  }

  async function del(id) {
    const rule = project?.rules?.find(r => r.id === id);
    const ok = await confirm(
      `Delete the rule "${rule?.metric || 'this rule'}" (${ruleLabel(rule || {})})? This cannot be undone.`,
      'Delete Rule'
    );
    if (!ok) return;
    await api.delete(`/projects/${project.id}/rules/${id}`);
    onProjectUpdated();
  }

  const metricCfg  = METRIC_CONFIG[form.metric] || METRIC_CONFIG['Response Time'];
  const isBetween  = form.operator === 'between';
  // Live conflict detection — recomputed on every form change
  const editingId  = modal === 'add' ? null : modal?.id;
  const conflicts  = modal ? findConflicts(form, project?.rules, editingId) : [];

  return (
    <div className="page fade-in">
      <div style={{ marginBottom: 16, padding: '14px 16px', background: 'var(--color-background-secondary)', borderRadius: 'var(--border-radius-md)', borderLeft: '3px solid var(--accent)' }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}><i className="ti ti-adjustments-horizontal" style={{ marginRight: 7, color: 'var(--accent)' }}/>Performance Configuration Rules</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Define thresholds for your metrics. Rules are applied during script generation to set pass/fail criteria.</div>
      </div>

      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px 110px 150px', gap: 8, padding: '0 0 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, color: 'var(--color-text-secondary)' }}>
          <div>Metric</div><div>Threshold</div><div>Severity</div><div>Actions</div>
        </div>

        {project.rules?.length ? project.rules.map(r => (
          <div className="rule-row" key={r.id} style={{ display: 'grid', gridTemplateColumns: '1fr 220px 110px 150px', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-chart-line" style={{ color: 'var(--accent)', fontSize: 15 }}/>
              <span style={{ fontWeight: 500, fontSize: 13.5 }}>{r.metric}</span>
            </div>
            <div style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ruleLabel(r)}</div>
            <div><span className={`badge ${r.severity === 'error' ? 'tag-red' : 'tag-amber'}`}>{r.severity}</span></div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn-icon" onClick={() => openEdit(r)}><i className="ti ti-edit" style={{ fontSize: 14 }}/></button>
              <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)', borderColor: 'rgba(247,84,100,0.3)' }} onClick={() => del(r.id)}><i className="ti ti-trash"/> Delete</button>
            </div>
          </div>
        )) : (
          <div className="empty" style={{ padding: 24 }}>
            <i className="ti ti-adjustments-horizontal"/>
            <div className="empty-title">No rules configured</div>
          </div>
        )}
      </div>

      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel}/>

      {modal && (
        <Modal onClose={() => setModal(null)}>
          <div className="modal-hdr">
            <div className="modal-title">{modal === 'add' ? 'Add' : 'Edit'} Performance Rule</div>
            <button className="btn-icon" onClick={() => setModal(null)}><i className="ti ti-x"/></button>
          </div>

          {/* Metric */}
          <div className="form-group">
            <label className="form-label">Metric</label>
            <CustomSelect value={form.metric} onChange={e => handleMetricChange(e.target.value)}>
              {METRICS.map(m => <option key={m} value={m}>{m}</option>)}
            </CustomSelect>
          </div>

          {/* Operator + Value(s) */}
          <div style={{ display: 'grid', gridTemplateColumns: isBetween ? '1fr 1fr 1fr' : '1fr 1fr', gap: 10 }}>
            {/* Operator */}
            <div className="form-group">
              <label className="form-label">Operator</label>
              <CustomSelect value={form.operator} onChange={e => handleOperatorChange(e.target.value)}>
                {metricCfg.operators.map(op => (
                  <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
                ))}
              </CustomSelect>
            </div>

            {isBetween ? (
              <>
                {/* From */}
                <div className="form-group">
                  <label className="form-label">From ({metricCfg.unit})</label>
                  <input type="number"
                    value={form.value_min}
                    onChange={e => setForm(f => ({ ...f, value_min: e.target.value }))}
                    placeholder="e.g. 200"
                    min={metricCfg.min} max={metricCfg.max} step={metricCfg.step}
                  />
                </div>
                {/* To */}
                <div className="form-group">
                  <label className="form-label">To ({metricCfg.unit})</label>
                  <input type="number"
                    value={form.value_max}
                    onChange={e => setForm(f => ({ ...f, value_max: e.target.value }))}
                    placeholder="e.g. 500"
                    min={metricCfg.min} max={metricCfg.max} step={metricCfg.step}
                  />
                </div>
              </>
            ) : (
              /* Single value */
              <div className="form-group">
                <label className="form-label">Value ({metricCfg.unit})</label>
                <input type="number"
                  value={form.value}
                  onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                  placeholder="e.g. 500"
                  min={metricCfg.min} max={metricCfg.max} step={metricCfg.step}
                />
              </div>
            )}
          </div>

          {/* Severity */}
          <div className="form-group">
            <label className="form-label">Severity</label>
            <CustomSelect value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value }))}>
              <option value="warning">Warning (alert only)</option>
              <option value="error">Error (fail test)</option>
            </CustomSelect>
          </div>

          {/* ── Conflict error — blocks saving, shown live as user fills values ── */}
          {conflicts.length > 0 && (
            <div style={{
              marginBottom: 14, padding: '12px 14px',
              background: '#fef2f2', border: '1.5px solid #fca5a5',
              borderRadius: 8, fontSize: 13,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>
                <i className="ti ti-xbox-x" style={{ fontSize: 16 }}/>
                Cannot save — conflicts with {conflicts.length} existing rule{conflicts.length > 1 ? 's' : ''}
              </div>
              <div style={{ fontSize: 12, color: '#991b1b', marginBottom: 10, lineHeight: 1.6 }}>
                The range you entered overlaps with {conflicts.length > 1 ? 'these existing rules' : 'this existing rule'} for <strong>{form.metric}</strong>.
                Please update or delete the conflicting rule first before adding this one.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {conflicts.map(r => (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 10px', background: '#fee2e2',
                    borderRadius: 6, border: '1px solid #fca5a5',
                  }}>
                    <i className="ti ti-git-compare" style={{ fontSize: 12, color: '#dc2626', flexShrink: 0 }}/>
                    <span style={{ fontWeight: 600, color: '#1e293b', fontSize: 12 }}>Rule #{r.id} —</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#374151' }}>{r.metric} {ruleLabel(r)}</span>
                    <span style={{
                      marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 20, flexShrink: 0,
                      background: r.severity === 'error' ? '#fecaca' : '#fef9c3',
                      color: r.severity === 'error' ? '#dc2626' : '#b45309',
                    }}>{r.severity}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: '#991b1b', display: 'flex', alignItems: 'center', gap: 5 }}>
                <i className="ti ti-arrow-back-up" style={{ fontSize: 13 }}/>
                Close this modal and edit the conflicting rule first, then come back to add this one.
              </div>
            </div>
          )}

          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving || conflicts.length > 0}
              title={conflicts.length > 0 ? 'Resolve conflicting rules before saving' : ''}>
              {saving && <span className="spinner"/>}{modal === 'add' ? 'Add Rule' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
