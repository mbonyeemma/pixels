declare global {
  interface Window {
    /** the 3D layer may set this to false when it knows WebGL is unavailable */
    __pixelsWebGL?: boolean;
  }
}

/** Quick WebGL feature test (cheap; frees the context immediately). */
export function hasWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.__pixelsWebGL === false) return false;
  if (window.__pixelsWebGL === true) return true;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
