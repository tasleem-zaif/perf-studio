import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import api from '../api';
import ConfirmModal from '../components/ConfirmModal';
import Modal from '../components/Modal';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';
import CustomSelect from '../components/CustomSelect';

// ─── Random data helpers ───────────────────────────────────────────────────

const FIRST_NAMES = ['Alice','Bob','Charlie','Diana','Eve','Frank','Grace','Henry','Iris','Jack','Kate','Liam','Mia','Noah','Olivia','Paul','Quinn','Rose','Sam','Tara','Uma','Victor','Wendy','Xander','Yara','Zoe'];
const LAST_NAMES  = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Anderson','Taylor','Thomas','Moore','Jackson','White','Harris','Martin','Thompson','Young','Lewis'];
const DOMAINS     = ['example.com','test.org','sample.net','demo.io','mail.com'];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randStr(len) { return Math.random().toString(36).slice(2, 2 + len).padEnd(len, 'x'); }
const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function randAlpha(len) { return Array.from({ length: len }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join(''); }
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function randomRawValue(dataType, maxLen) {
  const cap = v => (maxLen > 0 && String(v).length > maxLen) ? String(v).slice(0, maxLen) : String(v);
  const padOrTrim = v => {
    const s = String(v);
    if (maxLen <= 0) return s;
    if (s.length >= maxLen) return s.slice(0, maxLen);
    // pad with random alphanum to reach desired length
    return s + randStr(maxLen - s.length).slice(0, maxLen - s.length);
  };
  switch (dataType) {
    case 'Number': {
      if (maxLen > 0) {
        const digits = Math.min(maxLen, 15);
        if (digits === 1) return String(randInt(0, 9));
        const hi = Math.pow(10, digits) - 1;
        const lo = Math.pow(10, digits - 1);
        return String(randInt(lo, hi)).slice(0, maxLen);
      }
      return String(randInt(1, 99999));
    }
    case 'Decimal':  return cap((Math.random() * 1000).toFixed(2));
    case 'Email':    return cap(`${randStr(6)}@${DOMAINS[randInt(0, DOMAINS.length - 1)]}`);
    case 'UUID':     return cap(uuid());
    case 'Name':     return cap(`${FIRST_NAMES[randInt(0, FIRST_NAMES.length-1)]} ${LAST_NAMES[randInt(0, LAST_NAMES.length-1)]}`);
    case 'Username': return padOrTrim(`${FIRST_NAMES[randInt(0, FIRST_NAMES.length-1)].toLowerCase()}${randInt(10,999)}`);
    case 'Password': return padOrTrim(randStr(10) + randInt(10, 99) + '!');
    case 'Date':     return cap(new Date(Date.now() - randInt(0, 365*24*60*60*1000)).toISOString().split('T')[0]);
    case 'Phone':    return cap(`+1${randInt(2000000000, 9999999999)}`);
    case 'Boolean':  return cap(Math.random() > 0.5 ? 'true' : 'false');
    case 'URL':      return cap(`https://example.com/${randStr(6)}`);
    default:         return maxLen > 0 ? randAlpha(maxLen) : randAlpha(8); // Text — letters only
  }
}

function lengthWarning(col) {
  const total = parseInt(col.length) || 0;
  if (!total) return null;
  const used = (col.prefix || '').length + (col.postfix || '').length;
  if (used >= total) return `Prefix+Postfix (${used} chars) fills or exceeds length ${total} — no space left for data`;
  if (used > 0 && total - used < 2) return `Only ${total - used} char(s) left for data`;
  return null;
}

function generateCellValue(col) {
  const total  = parseInt(col.length) || 0;
  const prefix = col.prefix  || '';
  const postfix = col.postfix || '';
  const avail  = total > 0 ? Math.max(0, total - prefix.length - postfix.length) : 0;
  const raw    = randomRawValue(col.dataType, avail);
  return `${prefix}${raw}${postfix}`;
}

const DATA_TYPES = ['Text','Number','Decimal','Email','Username','Password','UUID','Name','Date','Phone','Boolean','URL'];
const EXTENSIONS = ['.csv', '.txt', '.xlsx', '.xls'];

function makeDefaultColumns(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `column${i + 1}`, dataType: 'Text', length: '', prefix: '', postfix: '' }));
}

const DEFAULT_GEN = { filename: 'test_data', extension: '.csv', numRows: 10, columns: makeDefaultColumns(3) };

// ─── Component ────────────────────────────────────────────────────────────

export default function TestData({ project, collection, env, onNav, onProjectUpdated, uploadTrigger, generateTrigger }) {
  const [files, setFiles] = useState([]);
  const [editing, setEditing] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showGenModal, setShowGenModal] = useState(false);
  const [genForm, setGenForm] = useState(DEFAULT_GEN);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  const fileInputRef = useRef(null);
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const { toast } = useToast();
  const [addColModal, setAddColModal] = useState(false);
  const [addColConfig, setAddColConfig] = useState({ name: '', dataType: 'Text', length: '', prefix: '', postfix: '', defaultValue: '' });
  const firstUploadRender = useRef(true);
  const firstGenRender = useRef(true);

  useEffect(() => { if (project) loadFiles(); }, [project?.id, collection?.id, env]);


  useEffect(() => {
    if (firstUploadRender.current) { firstUploadRender.current = false; return; }
    if (uploadTrigger > 0) fileInputRef.current?.click();
  }, [uploadTrigger]);

  useEffect(() => {
    if (firstGenRender.current) { firstGenRender.current = false; return; }
    if (generateTrigger > 0) { setGenForm(DEFAULT_GEN); setGenError(''); setShowGenModal(true); }
  }, [generateTrigger]);

  async function loadFiles() {
    const params = collection?.id ? `?collection_id=${collection.id}${env ? `&env=${encodeURIComponent(env)}` : ''}` : '';
    const { data } = await api.get(`/projects/${project.id}/test-data${params}`);
    setFiles(data.files || []);
  }

  if (!project) return <div className="page"><div className="empty"><i className="ti ti-folder-off" /><div className="empty-title">Select a project first</div></div></div>;

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('csv', file);
      const params = collection?.id ? `?collection_id=${collection.id}${env ? `&env=${encodeURIComponent(env)}` : ''}` : '';
      await api.post(`/projects/${project.id}/test-data${params}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await loadFiles();
    } catch (err) {
      toast(err.response?.data?.error || 'Upload failed', 'error');
    } finally { setUploading(false); e.target.value = ''; }
  }

  // ─── Generate data ────────────────────────────────────────────────────

  function updateNumCols(n) {
    const num = Math.max(1, Math.min(50, Number(n) || 1));
    setGenForm(prev => {
      const cols = [...prev.columns];
      while (cols.length < num) cols.push({ name: `column${cols.length + 1}`, dataType: 'Text', prefix: '', postfix: '' });
      return { ...prev, columns: cols.slice(0, num) };
    });
  }

  function updateCol(idx, field, value) {
    setGenForm(prev => ({ ...prev, columns: prev.columns.map((c, i) => i === idx ? { ...c, [field]: value } : c) }));
  }

  async function handleGenerate() {
    const numRows = Math.max(1, Math.min(100000, Number(genForm.numRows) || 10));
    const cols = genForm.columns.map((c, i) => ({ ...c, name: c.name.trim() || `col${i + 1}` }));
    if (!cols.length) return setGenError('Add at least one column');
    const badCol = cols.find(c => {
      const total = parseInt(c.length) || 0;
      return total > 0 && (c.prefix || '').length + (c.postfix || '').length >= total;
    });
    if (badCol) return setGenError(`Column "${badCol.name}": prefix+postfix length meets or exceeds the value length. Fix before generating.`);
    setGenerating(true); setGenError('');
    try {
      const headers = cols.map(c => c.name);
      const rows = Array.from({ length: numRows }, () => cols.map(col => generateCellValue(col)));

      const ext = genForm.extension;
      const baseName = (genForm.filename.trim() || 'test_data').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `${baseName}${ext}`;

      let blob;
      if (ext === '.csv' || ext === '.txt') {
        const escape = v => (String(v).includes(',') || String(v).includes('"')) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
        const lines = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))];
        blob = new Blob([lines.join('\r\n')], { type: 'text/plain' });
      } else {
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        const buf = XLSX.write(wb, { type: 'array', bookType: ext === '.xls' ? 'xls' : 'xlsx' });
        blob = new Blob([buf], { type: 'application/octet-stream' });
      }

      const file = new File([blob], filename, { type: blob.type });
      const fd = new FormData();
      fd.append('csv', file);
      fd.append('columns', JSON.stringify(headers));
      const colParams = collection?.id ? `?collection_id=${collection.id}${env ? `&env=${encodeURIComponent(env)}` : ''}` : '';
      await api.post(`/projects/${project.id}/test-data${colParams}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await loadFiles();
      setShowGenModal(false);
    } catch (e) {
      setGenError(e.response?.data?.error || e.message || 'Generation failed');
    } finally { setGenerating(false); }
  }

  // ─── Editor ───────────────────────────────────────────────────────────

  async function openEditor(f) {
    try {
      const { data } = await api.get(`/projects/${project.id}/test-data/${f.id}/content`);
      setEditing({ fileId: f.id, fileObj: f, headers: data.headers, rows: data.rows, totalRows: data.totalRows });
      setDirty(false);
    } catch (e) { toast(e.response?.data?.error || 'Failed to load file', 'error'); }
  }

  async function saveEdits() {
    if (!editing) return;
    setSaving(true);
    try {
      await api.put(`/projects/${project.id}/test-data/${editing.fileId}/content`, { headers: editing.headers, rows: editing.rows });
      await loadFiles(); setDirty(false);
      toast('File saved successfully', 'success');
    } catch (e) { toast(e.response?.data?.error || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  async function del(id) {
    const file = files.find(f => f.id === id);
    const ok = await confirm(`Delete "${file?.original_name || 'this file'}"? This cannot be undone.`, 'Delete Test Data File');
    if (!ok) return;
    await api.delete(`/projects/${project.id}/test-data/${id}`);
    if (editing?.fileId === id) setEditing(null);
    loadFiles();
  }

  function updateCell(rowIdx, colIdx, value) {
    setEditing(e => ({ ...e, rows: e.rows.map((r, ri) => ri === rowIdx ? r.map((c, ci) => ci === colIdx ? value : c) : r) }));
    setDirty(true);
  }
  function updateHeader(colIdx, value) {
    setEditing(e => ({ ...e, headers: e.headers.map((h, i) => i === colIdx ? value : h) }));
    setDirty(true);
  }
  function addRow() { setEditing(e => ({ ...e, rows: [...e.rows, e.headers.map(() => '')] })); setDirty(true); }
  function moveColumn(colIdx, dir) {
    const newIdx = colIdx + dir;
    setEditing(e => {
      if (newIdx < 0 || newIdx >= e.headers.length) return e;
      const headers = [...e.headers];
      [headers[colIdx], headers[newIdx]] = [headers[newIdx], headers[colIdx]];
      const rows = e.rows.map(r => {
        const row = [...r];
        [row[colIdx], row[newIdx]] = [row[newIdx], row[colIdx]];
        return row;
      });
      return { ...e, headers, rows };
    });
    setDirty(true);
  }
  function removeRow(idx) { setEditing(e => ({ ...e, rows: e.rows.filter((_, i) => i !== idx) })); setDirty(true); }
  function addColumn() {
    setAddColConfig({ name: '', dataType: 'Text', length: '', prefix: '', postfix: '', defaultValue: '' });
    setAddColModal(true);
  }
  function confirmAddColumn() {
    const colName = addColConfig.name.trim() || `column${(editing?.headers?.length || 0) + 1}`;
    const warn = lengthWarning(addColConfig);
    if (warn) return;
    setEditing(e => ({
      ...e,
      headers: [...e.headers, colName],
      rows: e.rows.map(r => [...r, `${addColConfig.prefix || ''}${addColConfig.defaultValue}${addColConfig.postfix || ''}`]),
    }));
    setDirty(true);
    setAddColModal(false);
  }
  async function removeColumn(colIdx) {
    const ok = await confirm(`Remove column "${editing.headers[colIdx]}"? All data in this column will be lost.`, 'Remove Column');
    if (!ok) return;
    setEditing(e => ({ ...e, headers: e.headers.filter((_, i) => i !== colIdx), rows: e.rows.map(r => r.filter((_, i) => i !== colIdx)) }));
    setDirty(true);
  }

  const parseColumns = (colStr) => { try { return JSON.parse(colStr).join(', '); } catch { return colStr; } };

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="page fade-in">
      <input ref={fileInputRef} type="file" accept=".csv,.txt,.xlsx,.xls" style={{ display: 'none' }} onChange={handleUpload} />

      <div className="breadcrumb">
        <a onClick={() => onNav('dashboard')}><i className="ti ti-layout-dashboard" style={{ fontSize: '12px', marginRight: '4px' }} />Dashboard</a>
        <i className="ti ti-chevron-right" style={{ fontSize: '12px' }} />
        <a onClick={() => onNav('project-home')}><i className="ti ti-folder" style={{ fontSize: '12px', marginRight: '4px' }} />{project.name}</a>
        <i className="ti ti-chevron-right" style={{ fontSize: '12px' }} />
        <span><i className="ti ti-table" style={{ fontSize: '12px', marginRight: '4px' }} />Test Data</span>
      </div>

      {uploading && (
        <div style={{ padding: '10px 14px', background: '#e8f0ff', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
          <span className="spinner" style={{ marginRight: '8px' }} />Uploading file...
        </div>
      )}

      {!editing ? (
        <>
          <div className="section-hdr">
            <div className="section-title"><i className="ti ti-table" style={{ marginRight: '8px', color: 'var(--accent)' }} />Test Data Files <span className="badge tag-gray">{files.length}</span></div>
          </div>

          {files.length ? (
            <div className="card">
              {files.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: '#e0faf3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <i className="ti ti-table" style={{ color: '#00c896' }} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '14px' }}>{f.original_name}</div>
                      <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Columns: {parseColumns(f.columns)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button className="btn-secondary btn-sm" onClick={() => openEditor(f)}><i className="ti ti-edit" /> Edit</button>
                    <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)', borderColor: 'rgba(247,84,100,0.3)' }} onClick={() => del(f.id)}><i className="ti ti-trash" /> Delete</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">
              <i className="ti ti-table" />
              <div className="empty-title">No test data files</div>
              <div className="empty-sub">Generate or upload a data file to use as test data</div>
            </div>
          )}
        </>
      ) : (
        /* ─── Inline editor ─── */
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button className="btn-secondary btn-sm" onClick={async () => { if (dirty) { const ok = await confirm('You have unsaved changes. Discard them?', 'Discard Changes'); if (!ok) return; } setEditing(null); }}>
                <i className="ti ti-arrow-left" /> Back
              </button>
              <div>
                <div style={{ fontWeight: 600, fontSize: '15px' }}>{editing.fileObj.original_name}</div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                  {editing.rows.length} rows shown{editing.totalRows > editing.rows.length ? ` of ${editing.totalRows} total` : ''}
                  {editing.totalRows > 500 && <span style={{ color: 'var(--warn)', marginLeft: '8px' }}><i className="ti ti-alert-triangle" /> Showing first 500 rows</span>}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-secondary btn-sm" onClick={addRow}><i className="ti ti-plus" /> Add Row</button>
              <button className="btn-secondary btn-sm" onClick={addColumn}><i className="ti ti-column-insert-right" /> Add Column</button>
              <button className="btn-primary btn-sm" onClick={saveEdits} disabled={saving || !dirty}>
                {saving ? <><span className="spinner" />Saving...</> : <><i className="ti ti-device-floppy" />Save Changes</>}
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--color-border-secondary)', borderRadius: '10px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--color-background-secondary)' }}>
                  <th style={{ width: '40px', padding: '8px 10px', borderBottom: '1px solid var(--color-border-secondary)', color: 'var(--color-text-tertiary)', fontSize: '11px' }}>#</th>
                  {editing.headers.map((h, ci) => (
                    <th key={ci} style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border-secondary)', textAlign: 'left' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input style={{ flex: 1, border: 'none', background: 'transparent', fontWeight: 600, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--color-text-secondary)', outline: 'none' }} value={h} onChange={e => updateHeader(ci, e.target.value)} />
                        <button onClick={() => moveColumn(ci, -1)} disabled={ci === 0} title="Move left" style={{ background: 'none', border: 'none', cursor: ci === 0 ? 'default' : 'pointer', color: ci === 0 ? 'var(--color-text-disabled, #555)' : 'var(--color-text-tertiary)', padding: '0 1px', fontSize: '12px', opacity: ci === 0 ? 0.3 : 1 }}><i className="ti ti-chevron-left" /></button>
                        <button onClick={() => moveColumn(ci, 1)} disabled={ci === editing.headers.length - 1} title="Move right" style={{ background: 'none', border: 'none', cursor: ci === editing.headers.length - 1 ? 'default' : 'pointer', color: ci === editing.headers.length - 1 ? 'var(--color-text-disabled, #555)' : 'var(--color-text-tertiary)', padding: '0 1px', fontSize: '12px', opacity: ci === editing.headers.length - 1 ? 0.3 : 1 }}><i className="ti ti-chevron-right" /></button>
                        <button onClick={() => removeColumn(ci)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: '0 2px', fontSize: '12px' }}>×</button>
                      </div>
                    </th>
                  ))}
                  <th style={{ width: '36px' }} />
                </tr>
              </thead>
              <tbody>
                {editing.rows.map((row, ri) => (
                  <tr key={ri} style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                    <td style={{ padding: '6px 10px', color: 'var(--color-text-tertiary)', fontSize: '11px', textAlign: 'center' }}>{ri + 1}</td>
                    {editing.headers.map((_, ci) => (
                      <td key={ci} style={{ padding: '2px 4px' }}>
                        <input style={{ width: '100%', border: '1px solid transparent', borderRadius: '4px', padding: '4px 8px', fontSize: '13px', background: 'transparent' }} value={row[ci] ?? ''} onChange={e => updateCell(ri, ci, e.target.value)} onFocus={e => e.target.style.border = '1px solid var(--accent)'} onBlur={e => e.target.style.border = '1px solid transparent'} />
                      </td>
                    ))}
                    <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                      <button onClick={() => removeRow(ri)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: '14px' }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />

      {/* ─── Add Column modal ─── */}
      {addColModal && (() => {
        const warn = lengthWarning(addColConfig);
        return (
          <Modal onClose={() => setAddColModal(false)}>
            <div className="modal-hdr">
              <div className="modal-title"><i className="ti ti-column-insert-right" style={{ marginRight: '8px', color: 'var(--accent)' }} />Add Column</div>
              <button className="btn-icon" onClick={() => setAddColModal(false)}><i className="ti ti-x" /></button>
            </div>

            <div className="form-group">
              <label className="form-label">Column Name</label>
              <input type="text" value={addColConfig.name} onChange={e => setAddColConfig(c => ({ ...c, name: e.target.value }))}
                placeholder={`column${(editing?.headers?.length || 0) + 1}`} autoFocus />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label className="form-label">Data Type</label>
                <CustomSelect value={addColConfig.dataType} onChange={e => setAddColConfig(c => ({ ...c, dataType: e.target.value }))}>
                  {DATA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </CustomSelect>
              </div>
              <div className="form-group">
                <label className="form-label">Length <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>— optional</span></label>
                <input type="number" min="1" value={addColConfig.length}
                  onChange={e => setAddColConfig(c => ({ ...c, length: e.target.value }))}
                  placeholder="Any"
                  style={{ border: warn ? '1px solid var(--danger)' : undefined, background: warn ? 'rgba(247,84,100,0.06)' : undefined }} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label className="form-label">Prefix <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>— optional</span></label>
                <input type="text" value={addColConfig.prefix} onChange={e => setAddColConfig(c => ({ ...c, prefix: e.target.value }))} placeholder="e.g. user_" />
              </div>
              <div className="form-group">
                <label className="form-label">Postfix <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>— optional</span></label>
                <input type="text" value={addColConfig.postfix} onChange={e => setAddColConfig(c => ({ ...c, postfix: e.target.value }))} placeholder="e.g. _test" />
              </div>
            </div>

            {warn && (
              <div style={{ fontSize: '12px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', padding: '8px 10px', background: 'rgba(247,84,100,0.08)', borderRadius: '6px' }}>
                <i className="ti ti-alert-triangle" /> {warn}
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Default Value <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>— optional</span></label>
              <input type="text" value={addColConfig.defaultValue} onChange={e => setAddColConfig(c => ({ ...c, defaultValue: e.target.value }))}
                placeholder="Leave blank for empty cells" />
            </div>

            <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', marginBottom: '12px', padding: '8px 10px', background: 'var(--color-background-secondary)', borderRadius: '6px' }}>
              <i className="ti ti-info-circle" style={{ marginRight: '5px' }} />
              The default value will be set for all <strong>{editing?.rows?.length || 0}</strong> existing rows. You can edit individual cells afterwards.
            </div>

            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setAddColModal(false)}>Cancel</button>
              <button className="btn-primary" onClick={confirmAddColumn} disabled={!!warn}>
                <i className="ti ti-plus" /> Add Column
              </button>
            </div>
          </Modal>
        );
      })()}

      {/* ─── Generate Data modal ─── */}
      {showGenModal && (
        <Modal onClose={() => setShowGenModal(false)} closeOnOutsideClick={false} style={{ width: '720px', minWidth: '520px', maxWidth: '95vw', minHeight: '420px', resize: 'both', overflow: 'auto' }}>
          <div className="modal-hdr">
            <div className="modal-title"><i className="ti ti-wand" style={{ marginRight: '8px', color: 'var(--accent)' }} />Generate Test Data</div>
            <button className="btn-icon" onClick={() => setShowGenModal(false)}><i className="ti ti-x" /></button>
          </div>

          {genError && <div className="auth-error">{genError}</div>}

          {/* Row 1: filename + extension + rows */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">File Name</label>
              <input type="text" value={genForm.filename} onChange={e => setGenForm(f => ({ ...f, filename: e.target.value }))} placeholder="test_data" />
            </div>
            <div className="form-group">
              <label className="form-label">Extension</label>
              <CustomSelect value={genForm.extension} onChange={e => setGenForm(f => ({ ...f, extension: e.target.value }))}>
                {EXTENSIONS.map(ext => <option key={ext} value={ext}>{ext}</option>)}
              </CustomSelect>
            </div>
            <div className="form-group">
              <label className="form-label">Rows</label>
              <input type="number" value={genForm.numRows} min="1" max="100000" onChange={e => setGenForm(f => ({ ...f, numRows: +e.target.value }))} />
            </div>
          </div>

          {/* Column configurations */}
          <div style={{ marginBottom: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                Columns
                <span className="badge tag-gray">{genForm.columns.length}</span>
              </div>
              <button
                className="btn-secondary btn-sm"
                onClick={() => setGenForm(f => ({ ...f, columns: [...f.columns, { name: `column${f.columns.length + 1}`, dataType: 'Text', length: '', prefix: '', postfix: '' }] }))}
                disabled={genForm.columns.length >= 50}
              >
                <i className="ti ti-plus" /> Add Column
              </button>
            </div>

            {genForm.columns.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', fontSize: '13px', color: 'var(--color-text-tertiary)', border: '1px dashed var(--color-border-tertiary)', borderRadius: '6px' }}>
                No columns yet — click <strong>Add Column</strong> to get started
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 80px 90px 90px 32px', gap: '6px', padding: '6px 8px', background: 'var(--color-background-secondary)', borderRadius: '6px 6px 0 0', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text-tertiary)' }}>
                  <div>Column Name</div><div>Data Type</div><div>Length</div><div>Prefix</div><div>Postfix</div><div />
                </div>
                <div style={{ border: '1px solid var(--color-border-tertiary)', borderTop: 'none', borderRadius: '0 0 6px 6px', maxHeight: '280px', overflowY: 'auto' }}>
                  {genForm.columns.map((col, i) => {
                    const warn = lengthWarning(col);
                    return (
                      <div key={i} style={{ borderBottom: i < genForm.columns.length - 1 ? '1px solid var(--color-border-tertiary)' : 'none' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 80px 90px 90px 32px', gap: '6px', padding: '6px 8px', alignItems: 'center' }}>
                          <input
                            type="text"
                            value={col.name}
                            onChange={e => updateCol(i, 'name', e.target.value)}
                            placeholder={`column${i + 1}`}
                            style={{ padding: '5px 8px', fontSize: '13px', borderRadius: '5px', border: '1px solid var(--color-border)', background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
                          />
                          <CustomSelect value={col.dataType} onChange={e => updateCol(i, 'dataType', e.target.value)}
                            style={{ fontSize: '12px', minWidth: '140px' }}>
                            {DATA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </CustomSelect>
                          <input
                            type="number"
                            value={col.length}
                            onChange={e => updateCol(i, 'length', e.target.value)}
                            placeholder="Any"
                            min="1"
                            style={{ padding: '5px 6px', fontSize: '12px', borderRadius: '5px', border: `1px solid ${warn ? 'var(--danger)' : 'var(--color-border)'}`, background: warn ? 'rgba(247,84,100,0.06)' : 'var(--color-background)', color: 'var(--color-text-primary)' }}
                          />
                          <input
                            type="text"
                            value={col.prefix}
                            onChange={e => updateCol(i, 'prefix', e.target.value)}
                            placeholder="prefix"
                            style={{ padding: '5px 8px', fontSize: '12px', borderRadius: '5px', border: '1px solid var(--color-border)', background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
                          />
                          <input
                            type="text"
                            value={col.postfix}
                            onChange={e => updateCol(i, 'postfix', e.target.value)}
                            placeholder="postfix"
                            style={{ padding: '5px 8px', fontSize: '12px', borderRadius: '5px', border: '1px solid var(--color-border)', background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
                          />
                          <button
                            onClick={() => setGenForm(f => ({ ...f, columns: f.columns.filter((_, idx) => idx !== i) }))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px' }}
                            title="Remove column"
                          >
                            <i className="ti ti-trash" style={{ fontSize: '14px' }} />
                          </button>
                        </div>
                        {warn && (
                          <div style={{ padding: '2px 8px 6px 8px', fontSize: '11px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <i className="ti ti-alert-triangle" style={{ fontSize: '11px' }} />{warn}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Preview hint */}
          <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginBottom: '12px', padding: '8px 10px', background: 'var(--color-background-secondary)', borderRadius: '6px' }}>
            <i className="ti ti-info-circle" style={{ marginRight: '5px' }} />
            Generates <strong>{genForm.numRows}</strong> rows × <strong>{genForm.columns.length}</strong> columns → <strong>{genForm.filename || 'test_data'}{genForm.extension}</strong>
            {genForm.numRows > 10000 && <span style={{ color: 'var(--warn)', marginLeft: '8px' }}><i className="ti ti-alert-triangle" /> Large file may take a moment</span>}
          </div>

          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setShowGenModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
              {generating ? <><span className="spinner" />Generating...</> : <><i className="ti ti-wand" />Generate & Save</>}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
