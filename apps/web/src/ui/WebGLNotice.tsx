import { gameClient } from '../net/client';

export default function WebGLNotice() {
  return (
    <div className="fatal fatal--scene" role="alert">
      <div className="fatal-card glass">
        <h1>3D graphics aren&apos;t available</h1>
        <p>
          Pixels draws its town with WebGL, which this browser or device has switched off. Try enabling hardware acceleration in your browser settings, updating your graphics drivers, or using a recent version of Chrome, Edge,
          Firefox or Safari.
        </p>
        <p>Chat and the Town Guide still work while you sort that out.</p>
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            Try again
          </button>
          <button type="button" className="btn" onClick={() => gameClient.logout()}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
