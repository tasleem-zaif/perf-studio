import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';

export default function CustomSelect({ value, onChange, children, className = '', style = {}, disabled = false }) {
  const [open,    setOpen]    = useState(false);
  const [hovered, setHovered] = useState(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0, flipUp: false });
  const wrapRef = useRef(null);

  // Parse <option> children into a flat list
  const options = [];
  const arr = Array.isArray(children) ? children.flat() : [children];
  for (const c of arr) {
    if (c && c.type === 'option') {
      options.push({
        value:    c.props.value ?? c.props.children,
        label:    c.props.children,
        disabled: !!c.props.disabled,
      });
    }
  }

  const selected = options.find(o => String(o.value) === String(value));

  // The app renders at `html { zoom: 0.9 }` (see index.css). getBoundingClientRect()
  // returns coordinates already scaled by that zoom, but a position:fixed element
  // (this dropdown is portaled to document.body, still under the zoomed <html>) has
  // its own top/left/width re-scaled by the browser on top of that — a double-zoom.
  // Dividing by the zoom factor before writing the inline style cancels it out.
  function getZoom() {
    const z = parseFloat(getComputedStyle(document.documentElement).zoom);
    return z && !isNaN(z) ? z : 1;
  }

  // Calculate dropdown position using getBoundingClientRect (no overflow hacks)
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    const zoom = getZoom();
    const dropH = Math.min(options.length * 36 + 8, 260);
    const flipUp = window.innerHeight - r.bottom < dropH + 8 && r.top > dropH + 8;
    setDropPos({ top: (r.bottom + 3) / zoom, bottom: (r.top - 3) / zoom, left: r.left / zoom, width: r.width / zoom, flipUp });
  }, [open]);

  // Recalculate on scroll/resize while open
  useEffect(() => {
    if (!open) return;
    function update() {
      if (!wrapRef.current) return;
      const r = wrapRef.current.getBoundingClientRect();
      const zoom = getZoom();
      const dropH = Math.min(options.length * 36 + 8, 260);
      const flipUp = window.innerHeight - r.bottom < dropH + 8 && r.top > dropH + 8;
      setDropPos({ top: (r.bottom + 3) / zoom, bottom: (r.top - 3) / zoom, left: r.left / zoom, width: r.width / zoom, flipUp });
    }
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        // Check if click is inside the portal dropdown
        const portal = document.getElementById('custom-select-portal');
        if (portal && portal.contains(e.target)) return;
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function pick(opt) {
    if (opt.disabled) return;
    onChange({ target: { value: opt.value } });
    setOpen(false);
  }

  // Dropdown rendered into body via portal — never clips, never jumps scroll
  const dropdown = open && createPortal(
    <div
      id="custom-select-portal"
      style={{
        position: 'fixed',
        ...(dropPos.flipUp
          ? { bottom: window.innerHeight - dropPos.bottom, top: 'auto' }
          : { top: dropPos.top, bottom: 'auto' }),
        left:      dropPos.left,
        width:     dropPos.width,
        background: 'var(--color-background-secondary)',
        border:    '1px solid var(--input-focus)',
        borderRadius: 'var(--border-radius-md)',
        zIndex:    99999,
        maxHeight: '260px',
        overflowY: 'auto',
        boxShadow: 'var(--shadow-modal)',
      }}
    >
      {options.map(opt => {
        const isHov = hovered === opt.value;
        const isSel = String(opt.value) === String(value);
        return (
          <div
            key={opt.value}
            onMouseEnter={() => setHovered(opt.value)}
            onMouseLeave={() => setHovered(null)}
            onMouseDown={e => { e.preventDefault(); pick(opt); }}
            style={{
              padding:    '8px 10px',
              fontSize:   '12px',
              fontFamily: 'var(--font)',
              cursor:     opt.disabled ? 'not-allowed' : 'pointer',
              background: isHov ? 'var(--accent)' : isSel ? 'var(--accent-active-bg)' : 'transparent',
              color:      isHov ? '#fff' : isSel ? 'var(--accent-active-text)' : opt.disabled ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
              opacity:    opt.disabled ? 0.5 : 1,
              transition: 'background .08s',
            }}
          >
            {opt.label}
          </div>
        );
      })}
    </div>,
    document.body
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }} className={className}>
      {/* Trigger */}
      <div
        onClick={() => !disabled && setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '7px 10px',
          background: 'var(--input-bg)',
          border: `1px solid ${open ? 'var(--input-focus)' : 'var(--input-border)'}`,
          borderRadius: 'var(--border-radius-md)',
          color: 'var(--color-text-primary)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: '12px', fontFamily: 'var(--font)',
          opacity: disabled ? 0.5 : 1,
          boxShadow: open ? '0 0 0 2px rgba(73,204,61,0.15)' : 'none',
          transition: 'border-color .12s, box-shadow .12s',
          userSelect: 'none',
          width: '100%',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label ?? value ?? ''}
        </span>
        <i
          className={`ti ti-chevron-${open ? 'up' : 'down'}`}
          style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', flexShrink: 0, marginLeft: '6px' }}
        />
      </div>

      {/* Portal dropdown */}
      {dropdown}
    </div>
  );
}
