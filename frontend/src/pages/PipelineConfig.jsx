import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import { useToast } from '../hooks/useToast';

const DEFAULT_FORM = { name: '', description: '', steps: [], stop_on_failure: true, environment: '' };

function StepRow({ step, index, total, onRemove, onMoveUp, onMoveDown }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 6 }}>
      <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#e0e7ff', color: '#4338ca', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
      <i className="ti ti-test-pipe" style={{ color: '#4338ca', fontSize: 14, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{step.name}</div>
        {step.engine && <div style={{ fontSize: 11, color: '#64748b' }}>{step.engine.toUpperCase()} · {step.test_type || 'load'}</div>}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button onClick={() => onMoveUp(index)} disabled={index === 0} className="btn-secondary btn-sm" style={{ padding: '3px 7px' }}><i className="ti ti-arrow-up" style={{ fontSize: 11 }} /></button>
        <button onClick={() => onMoveDown(index)} disabled={index === total - 1} className="btn-secondary btn-sm" style={{ padding: '3px 7px' }}><i className="ti ti-arrow-down" style={{ fontSize: 11 }} /></button>
        <button onClick={() => onRemove(index)} className="btn-secondary btn-sm" style={{ padding: '3px 7px', color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}><i className="ti ti-x" style={{ fontSize: 11 }} /></button>
      </div>
    </div>
  );
}

export default function PipelineConfig({ project, envs }) {
  const { toast } = useToast();
  const [pipelines, setPipelines]   = useState([]);
  const [suites,    setSuites]      = useState([]);
  const [modal,     setModal]       = useState(null); // null | 'add' | pipeline obj
  const [form,      setForm]        = useState(DEFAULT_FORM);
  const [saving,    setSaving]      = useState(false);
  const [runs,      setRuns]        = useState({});    // pipelineId → runs[]
  const [running,   setRunning]     = useState(null);  // pipelineId being run

  useEffect(() => {
    if (!project?.id) return;
    load();
    api.get(`/projects/${project.id}/test-suites`).then(r => setSuites(r.data.suites || [])).catch(() => {});
  }, [project?.id]);

  function load() {
    api.get(`/projects/${project.id}/pipelines`).then(r => setPipelines(r.data.pipelines || [])).catch(() => {});
  }

  function openAdd() {
    setForm(DEFAULT_FORM);
    setModal('add');
  }

  function openEdit(p) {
    setForm({ name: p.name, description: p.description || '', steps: JSON.parse(p.steps || '[]'), stop_on_failure: !!p.stop_on_failure, environment: p.environment || '' });
    setModal(p);
  }

  async function save() {
    if (!form.name.trim()) return toast('Pipeline name is required', 'warn');
    setSaving(true);
    try {
      if (modal === 'add') await api.post(`/projects/${project.id}/pipelines`, form);
      else await api.put(`/projects/${project.id}/pipelines/${modal.id}`, form);
      toast(modal === 'add' ? 'Pipeline created' : 'Pipeline updated', 'success');
      setModal(null);
      load();
    } catch (e) { toast(e.response?.data?.error || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  async function deletePipeline(id) {
    if (!window.confirm('Delete this pipeline?')) return;
    await api.delete(`/projects/${project.id}/pipelines/${id}`).catch(() => {});
    toast('Pipeline deleted', 'success');
    load();
  }

  async function runPipeline(pipeline) {
    setRunning(pipeline.id);
    try {
      const { data } = await api.post(`/projects/${project.id}/pipelines/${pipeline.id}/run`);
      toast(`Pipeline "${pipeline.name}" started`, 'success');
      // Refresh run history
      loadRuns(pipeline.id);
    } catch (e) { toast(e.response?.data?.error || 'Run failed', 'error'); }
    finally { setRunning(null); }
  }

  async function loadRuns(pipelineId) {
    const { data } = await api.get(`/projects/${project.id}/pipelines/${pipelineId}/runs`).catch(() => ({ data: { runs: [] } }));
    setRuns(prev => ({ ...prev, [pipelineId]: data.runs || [] }));
  }

  function addStep(suite) {
    if (form.steps.find(s => s.suite_id === suite.id)) return;
    setForm(f => ({ ...f, steps: [...f.steps, { suite_id: suite.id, name: suite.name, engine: suite.engine, test_type: suite.test_type }] }));
  }

  function removeStep(i) { setForm(f => ({ ...f, steps: f.steps.filter((_, idx) => idx !== i) })); }
  function moveUp(i)      { if (i === 0) return; const s = [...form.steps]; [s[i-1], s[i]] = [s[i], s[i-1]]; setForm(f => ({ ...f, steps: s })); }
  function moveDown(i)    { if (i === form.steps.length - 1) return; const s = [...form.steps]; [s[i], s[i+1]] = [s[i+1], s[i]]; setForm(f => ({ ...f, steps: s })); }

  const availableSuites = suites.filter(s => !form.steps.find(st => st.suite_id === s.id));

  function StatusBadge({ status }) {
    const map = { running: ['#dbeafe','#1d4ed8'], completed: ['#dcfce7','#16a34a'], failed: ['#fee2e2','#dc2626'], pending: ['#f1f5f9','#64748b'] };
    const [bg, color] = map[status] || map.pending;
    return <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: bg, color }}>{status}</span>;
  }

  return (
    <div className="page fade-in">
      {pipelines.length === 0 ? (
        <div className="empty">
          <i className="ti ti-git-merge" />
          <div className="empty-title">No pipelines yet</div>
          <div className="empty-sub">Create a pipeline to run multiple test plans in sequence</div>
          <button className="btn-primary" style={{ marginTop: 16 }} onClick={openAdd}>
            <i className="ti ti-plus" /> Create Pipeline
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button className="btn-primary" onClick={openAdd}><i className="ti ti-plus" /> Create Pipeline</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pipelines.map(p => {
              const steps = JSON.parse(p.steps || '[]');
              const pipelineRuns = runs[p.id] || [];
              return (
                <div key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: '16px 20px', background: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#e0e7ff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <i className="ti ti-git-merge" style={{ color: '#4338ca', fontSize: 16 }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{p.name}</div>
                          {p.description && <div style={{ fontSize: 12, color: '#64748b' }}>{p.description}</div>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: '#64748b', marginTop: 8 }}>
                        <span><i className="ti ti-list-numbers" style={{ marginRight: 4 }} />{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
                        {p.environment && <span><i className="ti ti-tag" style={{ marginRight: 4 }} />{p.environment}</span>}
                        <span><i className="ti ti-player-stop" style={{ marginRight: 4, color: p.stop_on_failure ? '#ef4444' : '#94a3b8' }} />{p.stop_on_failure ? 'Stop on failure' : 'Continue on failure'}</span>
                      </div>
                      {/* Steps preview */}
                      {steps.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                          {steps.map((s, i) => (
                            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', background: '#f1f5f9', borderRadius: 20, fontSize: 11, color: '#475569' }}>
                              <span style={{ fontWeight: 700, color: '#4338ca' }}>{i + 1}.</span> {s.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button className="btn-primary btn-sm" onClick={() => runPipeline(p)} disabled={running === p.id}>
                        {running === p.id ? <span className="spinner" /> : <i className="ti ti-player-play" />} Run
                      </button>
                      <button className="btn-secondary btn-sm" onClick={() => { openEdit(p); }}><i className="ti ti-pencil" /></button>
                      <button className="btn-secondary btn-sm" style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }} onClick={() => deletePipeline(p.id)}><i className="ti ti-trash" /></button>
                    </div>
                  </div>

                  {/* Run history toggle */}
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #f1f5f9' }}>
                    <button onClick={() => pipelineRuns.length ? setRuns(prev => ({ ...prev, [p.id]: [] })) : loadRuns(p.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}>
                      <i className={`ti ti-history`} style={{ fontSize: 13 }} />
                      {pipelineRuns.length ? 'Hide' : 'Show'} run history
                    </button>
                    {pipelineRuns.length > 0 && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {pipelineRuns.map(r => (
                          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: '#f8fafc', borderRadius: 6, fontSize: 12 }}>
                            <StatusBadge status={r.status} />
                            <span style={{ color: '#475569' }}>{r.started_at?.slice(0, 16).replace('T', ' ')}</span>
                            {r.finished_at && <span style={{ color: '#94a3b8' }}>→ {r.finished_at?.slice(0, 16).replace('T', ' ')}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Add/Edit Modal */}
      {modal && (
        <Modal onClose={() => setModal(null)} closeOnOutsideClick={false} style={{ width: '620px', maxWidth: '95vw' }}>
          <div className="modal-hdr">
            <div className="modal-title"><i className="ti ti-git-merge" style={{ marginRight: 8, color: '#4338ca' }} />{modal === 'add' ? 'Create Pipeline' : 'Edit Pipeline'}</div>
            <button className="btn-icon" onClick={() => setModal(null)}><i className="ti ti-x" /></button>
          </div>

          <div className="form-group">
            <label className="form-label">Pipeline Name *</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Full Regression" autoFocus />
          </div>

          <div className="form-group">
            <label className="form-label">Description</label>
            <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What does this pipeline test?" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Environment</label>
              <input type="text" value={form.environment} onChange={e => setForm(f => ({ ...f, environment: e.target.value }))} placeholder="e.g. QA, Staging, UAT" />
            </div>
            <div className="form-group">
              <label className="form-label">On step failure</label>
              <select value={form.stop_on_failure ? 'stop' : 'continue'} onChange={e => setForm(f => ({ ...f, stop_on_failure: e.target.value === 'stop' }))} style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--color-border-secondary)', background: 'var(--input-bg)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit' }}>
                <option value="stop">Stop pipeline</option>
                <option value="continue">Continue to next step</option>
              </select>
            </div>
          </div>

          {/* Steps */}
          <div className="form-group">
            <label className="form-label">Test Plan Steps <span style={{ fontWeight: 400, color: '#64748b' }}>— drag to reorder</span></label>
            {form.steps.length === 0 ? (
              <div style={{ padding: '14px', textAlign: 'center', color: '#94a3b8', fontSize: 13, border: '1px dashed #e2e8f0', borderRadius: 8 }}>
                No steps added yet. Select test plans below.
              </div>
            ) : (
              form.steps.map((s, i) => (
                <StepRow key={s.suite_id} step={s} index={i} total={form.steps.length} onRemove={removeStep} onMoveUp={moveUp} onMoveDown={moveDown} />
              ))
            )}
          </div>

          {/* Available test plans to add */}
          {availableSuites.length > 0 && (
            <div className="form-group">
              <label className="form-label" style={{ color: '#64748b' }}>Add test plans</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {availableSuites.map(s => (
                  <button key={s.id} onClick={() => addStep(s)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', border: '1px solid #e2e8f0', borderRadius: 20, background: '#f8fafc', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: '#475569', transition: 'all .12s' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#4338ca'; e.currentTarget.style.color = '#4338ca'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#475569'; }}>
                    <i className="ti ti-plus" style={{ fontSize: 11 }} /> {s.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {suites.length === 0 && (
            <div style={{ padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e', marginBottom: 12 }}>
              <i className="ti ti-alert-triangle" style={{ marginRight: 6 }} />No test plans found. Create test plans first before building a pipeline.
            </div>
          )}

          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving && <span className="spinner" />}
              <i className="ti ti-device-floppy" /> {modal === 'add' ? 'Create Pipeline' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
