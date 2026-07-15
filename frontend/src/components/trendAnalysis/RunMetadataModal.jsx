import { useState } from 'react';
import Modal from '../Modal';
import { D } from '../../theme/analyticsDark';

const FIELDS = [
  { key: 'build_number', label: 'Build Number',  placeholder: 'e.g. 241' },
  { key: 'release_tag',  label: 'Release',       placeholder: 'e.g. 5.2' },
  { key: 'browser',      label: 'Browser',       placeholder: 'e.g. Chrome' },
  { key: 'load_profile', label: 'Load Profile',  placeholder: 'e.g. 500 users / 10 min ramp-up' },
];

/**
 * Small tagging form — sets the run-metadata fields Trend Analysis filters on.
 * Nothing else in the app currently writes these, so this is the only entry point.
 * Environment isn't here — it's test_suites.env, already set when the run's
 * suite/collection environment was chosen (same value EnvBar/Analytics.jsx show).
 */
export default function RunMetadataModal({ run, onClose, onSaved }) {
  const [values, setValues] = useState(() =>
    FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: run[f.key] || '' }), {})
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await onSaved(run.id, values);
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save run metadata');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} closeOnOutsideClick style={{ background: D.pageBg, border:`1px solid ${D.border}`, borderRadius:12, padding:24, maxWidth:420, width:'90%' }}>
      <div style={{ fontSize:16, fontWeight:700, color:D.textPri, marginBottom:4 }}>
        <i className="ti ti-tag" style={{ marginRight:7, color:D.accent }} />
        Tag Run Metadata
      </div>
      <div style={{ fontSize:12, color:D.textTer, marginBottom:16 }}>
        These values power Trend Analysis filters and comparisons.
      </div>

      {FIELDS.map(f => (
        <div key={f.key} style={{ marginBottom:12 }}>
          <label style={{ display:'block', marginBottom:4, fontSize:10, fontWeight:700, color:D.textSec, textTransform:'uppercase', letterSpacing:'.5px' }}>
            {f.label}
          </label>
          <input
            value={values[f.key]}
            placeholder={f.placeholder}
            onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
            style={{ width:'100%', padding:'8px 11px', borderRadius:6, border:`1px solid ${D.border}`, background:D.cardBg2, color:D.textPri, fontSize:13 }}
          />
        </div>
      ))}

      {error && <div style={{ color:'#ef4444', fontSize:12, marginBottom:10 }}>{error}</div>}

      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:6 }}>
        <button
          onClick={onClose}
          disabled={saving}
          style={{ padding:'7px 16px', borderRadius:6, border:`1px solid ${D.border}`, background:'transparent', color:D.textSec, fontSize:13, cursor:'pointer' }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ padding:'7px 16px', borderRadius:6, border:'none', background:D.accent, color:'#0d1117', fontSize:13, fontWeight:700, cursor:'pointer' }}
        >
          {saving ? <span className="spinner" style={{ margin:0 }} /> : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
