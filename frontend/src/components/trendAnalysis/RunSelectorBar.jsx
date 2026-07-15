import CustomSelect from '../CustomSelect';
import { D } from '../../theme/analyticsDark';

const MODES = [
  { id: 'list',         label: 'All Runs',          icon: 'ti-list' },
  { id: 'baseline',     label: 'Baseline vs Latest', icon: 'ti-git-compare' },
  { id: 'last_n',       label: 'Last N Executions',  icon: 'ti-history' },
  { id: 'custom_range', label: 'Custom Date Range',  icon: 'ti-calendar' },
];

const FILTER_FIELDS = [
  { key: 'environment',   label: 'Environment' },
  { key: 'browser',       label: 'Browser' },
  { key: 'build_number',  label: 'Build Number' },
  { key: 'release_tag',   label: 'Release' },
  { key: 'load_profile',  label: 'Load Profile' },
];

function labelStyle() {
  return { marginBottom:4, display:'block', color:D.textSec, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'.6px' };
}

/**
 * Filter bar (environment/browser/build/release/load-profile/test-plan) + run
 * selector mode (all runs / baseline vs latest / last N / custom date range).
 * Purely controlled — all state lives in the parent (TrendAnalysisTab).
 */
export default function RunSelectorBar({
  filters, onFilterChange, filterOptions,
  mode, onModeChange,
  lastN, onLastNChange,
  dateFrom, dateTo, onDateFromChange, onDateToChange,
}) {
  return (
    <div style={{ background: D.cardBg, border:`1px solid ${D.border}`, borderRadius:10, padding:16, marginBottom:16 }}>
      {/* Selector mode */}
      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
        {MODES.map(m => (
          <button
            key={m.id}
            onClick={() => onModeChange(m.id)}
            style={{
              display:'flex', alignItems:'center', gap:6,
              padding:'6px 13px', fontSize:12, fontWeight:600, borderRadius:7,
              border: `1px solid ${mode===m.id ? D.accent : D.border}`,
              background: mode===m.id ? 'rgba(73,204,61,0.12)' : 'transparent',
              color: mode===m.id ? D.accent : D.textSec,
              cursor:'pointer', whiteSpace:'nowrap',
            }}
          >
            <i className={`ti ${m.icon}`} style={{ fontSize:13 }} />
            {m.label}
          </button>
        ))}
      </div>

      {/* Mode-specific controls */}
      {mode === 'last_n' && (
        <div style={{ marginBottom:14, maxWidth:160 }}>
          <label style={labelStyle()}>Number of executions</label>
          <input
            type="number" min={1} max={1000} value={lastN}
            onChange={e => onLastNChange(Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 1)))}
            style={{ width:'100%', padding:'7px 10px', borderRadius:6, border:`1px solid ${D.border}`, background:D.cardBg2, color:D.textPri, fontSize:13 }}
          />
        </div>
      )}
      {mode === 'custom_range' && (
        <div style={{ display:'flex', gap:12, marginBottom:14, flexWrap:'wrap' }}>
          <div>
            <label style={labelStyle()}>From</label>
            <input
              type="date" value={dateFrom || ''} onChange={e => onDateFromChange(e.target.value)}
              style={{ padding:'7px 10px', borderRadius:6, border:`1px solid ${D.border}`, background:D.cardBg2, color:D.textPri, fontSize:13 }}
            />
          </div>
          <div>
            <label style={labelStyle()}>To</label>
            <input
              type="date" value={dateTo || ''} onChange={e => onDateToChange(e.target.value)}
              style={{ padding:'7px 10px', borderRadius:6, border:`1px solid ${D.border}`, background:D.cardBg2, color:D.textPri, fontSize:13 }}
            />
          </div>
        </div>
      )}

      {/* Metadata filters */}
      <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
        {FILTER_FIELDS.map(f => (
          <div key={f.key} style={{ minWidth:150 }}>
            <label style={labelStyle()}>{f.label}</label>
            <CustomSelect value={filters[f.key] || ''} onChange={e => onFilterChange(f.key, e.target.value)} style={{ width:'100%' }}>
              <option value="">All</option>
              {(filterOptions[f.key] || []).map(v => <option key={v} value={v}>{v}</option>)}
            </CustomSelect>
          </div>
        ))}
        <div style={{ minWidth:170 }}>
          <label style={labelStyle()}>Test Plan</label>
          <CustomSelect value={filters.suite_id || ''} onChange={e => onFilterChange('suite_id', e.target.value)} style={{ width:'100%' }}>
            <option value="">All</option>
            {(filterOptions.test_plans || []).map(tp => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
          </CustomSelect>
        </div>
      </div>
    </div>
  );
}
