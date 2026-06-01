import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error.message, error.stack, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '24px', background: '#fcebeb', borderRadius: '12px', margin: '24px', fontFamily: 'monospace', fontSize: '13px' }}>
          <div style={{ fontWeight: 700, color: '#a32d2d', marginBottom: '8px' }}>Runtime Error</div>
          <div style={{ color: '#a32d2d', marginBottom: '12px' }}>{this.state.error.message}</div>
          <pre style={{ fontSize: '11px', color: '#666', overflow: 'auto', maxHeight: '200px' }}>{this.state.error.stack}</pre>
          <button style={{ marginTop: '12px', padding: '6px 14px', background: '#a32d2d', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            onClick={() => this.setState({ error: null })}>Dismiss</button>
        </div>
      );
    }
    return this.props.children;
  }
}
