import { useState, useRef, useLayoutEffect, useEffect } from 'react';

export default function CustomSelect({ value, onChange, children, className = '', style = {}, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [flipUp, setFlipUp] = useState(false);
  const wrapRef = useRef(null);
  const dropRef = useRef(null);

  const options = [];
  const arr = Array.isArray(children) ? children.flat() : [children];
  for (const c of arr) {
    if (c && c.type === 'option') {
      options.push({
        value: c.props.value ?? c.props.children,
        label: c.props.children,
        disabled: !!c.props.disabled,
      });
    }
  }

  const selected = options.find(o => String(o.value) === String(value));

  // When the dropdown opens, temporarily set overflow:visible on every
  // ancestor that would clip it. Restore on close.
  // This lets position:absolute top:100% work with no JS coordinate math.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;

    // Decide flip direction
    const r = wrapRef.current.getBoundingClientRect();
    const dropH = Math.min(options.length * 36 + 8, 260);
    setFlipUp(window.innerHeight - r.bottom < dropH + 8 && r.top > dropH + 8);

    // Clear overflow on ancestors
    const restored = [];
    let el = wrapRef.current.parentElement;
    while (el && el !== document.body) {
      const cs = window.getComputedStyle(el);
      const ov = cs.overflow;
      const ovY = cs.overflowY;
      if (['auto', 'scroll', 'hidden'].some(v => ov === v || ovY === v)) {
        restored.push({ el, overflow: el.style.overflow, overflowY: el.style.overflowY });
        el.style.overflow = 'visible';
      }
      el = el.parentElement;
    }

    return () => {
      restored.forEach(({ el, overflow, overflowY }) => {
        el.style.overflow = overflow;
        el.style.overflowY = overflowY;
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (
        wrapRef.current && !wrapRef.current.contains(e.target) &&
        dropRef.current && !dropRef.current.contains(e.target)
      ) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function pick(opt) {
    if (opt.disabled) return;
    onChange({ target: { value: opt.value } });
    setOpen(false);
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }} className={className}>
      {/* Trigger button */}
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

      {/* Dropdown — position:absolute relative to this wrapper */}
      {open && (
        <div
          ref={dropRef}
          style={{
            position: 'absolute',
            ...(flipUp
              ? { bottom: 'calc(100% + 3px)', top: 'auto' }
              : { top: 'calc(100% + 3px)', bottom: 'auto' }),
            left: 0,
            minWidth: '100%',
            background: 'var(--color-background-secondary)',
            border: '1px solid var(--input-focus)',
            borderRadius: 'var(--border-radius-md)',
            zIndex: 99999,
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
                onClick={() => pick(opt)}
                style={{
                  padding: '8px 10px',
                  fontSize: '12px', fontFamily: 'var(--font)',
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  background: isHov ? 'var(--accent)' : isSel ? 'var(--accent-active-bg)' : 'transparent',
                  color: isHov ? '#fff' : isSel ? 'var(--accent-active-text)' : opt.disabled ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                  opacity: opt.disabled ? 0.5 : 1,
                  transition: 'background .08s',
                }}
              >
                {opt.label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
