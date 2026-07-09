import { useState } from 'react';

export default function CopyCommandBlock({ command, copyText }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(copyText ?? command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
      <code style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, color: '#4ade80', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {command}
      </code>
      <button className="btn-secondary btn-sm" onClick={copy} style={{ flexShrink: 0, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none' }}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}
