import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** "app" = whole-screen fatal card; "scene" = card shown in place of the 3D view while the HUD stays alive */
  scope?: 'app' | 'scene';
  onLogout?: () => void;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const scene = this.props.scope === 'scene';
    return (
      <div className={scene ? 'fatal fatal--scene' : 'fatal'} role="alert">
        <div className="fatal-card glass">
          <h1>{scene ? "The 3D view couldn't start" : 'Something went wrong'}</h1>
          <p>
            {scene
              ? 'Your browser or graphics driver may not support the 3D scene right now. Chat and the Town Guide still work.'
              : 'Pixels hit an unexpected problem. Reloading usually fixes it.'}
          </p>
          <details>
            <summary>Technical details</summary>
            <pre>{error.message}</pre>
          </details>
          <div className="row">
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            {this.props.onLogout ? (
              <button className="btn" onClick={this.props.onLogout}>
                Log out
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
}
