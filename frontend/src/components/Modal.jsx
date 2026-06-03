export default function Modal({ onClose, children, style, closeOnOutsideClick = false }) {
  return (
    <div className="modal-bg" onClick={e => closeOnOutsideClick && e.target === e.currentTarget && onClose()}>
      <div className="modal fade-in" style={style}>{children}</div>
    </div>
  );
}
