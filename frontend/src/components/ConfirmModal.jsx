import Modal from './Modal';

export default function ConfirmModal({ open, title, message, confirmLabel = 'Delete', onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <Modal onClose={onCancel}>
      <div className="modal-hdr">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{
            width: '32px', height: '32px', borderRadius: '50%',
            background: 'rgba(247,84,100,0.12)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <i className="ti ti-alert-triangle" style={{ color: 'var(--danger)', fontSize: '16px' }} />
          </span>
          {title}
        </div>
        <button className="btn-icon" onClick={onCancel}><i className="ti ti-x" /></button>
      </div>
      <div style={{ fontSize: '14px', color: 'var(--color-text-secondary)', lineHeight: 1.6, padding: '4px 0 8px' }}>
        {message}
      </div>
      <div className="modal-footer">
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button
          className="btn-primary"
          style={{ background: 'var(--danger)', boxShadow: 'none' }}
          onClick={onConfirm}
        >
          <i className="ti ti-trash" /> {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
