import { createContext, useContext, useState, useCallback, useRef } from 'react';

const ToastContext = createContext(null);

// Duration per type (ms)
const DURATIONS = {
  success: 30000,
  error:   30000,
  warn:    12000,
  info:     5000,
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef      = useRef(0);
  const timersRef  = useRef({});

  const dismiss = useCallback(id => {
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  const toast = useCallback((message, type = 'info') => {
    const id       = ++idRef.current;
    const duration = DURATIONS[type] ?? 5000;
    setToasts(t => [{ id, message, type, duration }, ...t]); // newest on top
    timersRef.current[id] = setTimeout(() => dismiss(id), duration);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toast, toasts, dismiss }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
