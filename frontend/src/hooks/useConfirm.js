import { useState, useCallback } from 'react';

export function useConfirm() {
  const [state, setState] = useState({ open: false, title: '', message: '', confirmLabel: 'Delete', resolve: null });

  const confirm = useCallback((message, title = 'Confirm Delete', confirmLabel = 'Delete') => {
    return new Promise(resolve => {
      setState({ open: true, title, message, confirmLabel, resolve });
    });
  }, []);

  function handleConfirm() {
    state.resolve?.(true);
    setState(s => ({ ...s, open: false }));
  }

  function handleCancel() {
    state.resolve?.(false);
    setState(s => ({ ...s, open: false }));
  }

  return { confirm, confirmState: state, handleConfirm, handleCancel };
}
