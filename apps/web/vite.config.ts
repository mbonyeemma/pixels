import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Dev server proxies /api and /ws to the game server (default http://localhost:8787).
 * - VITE_PROXY_TARGET overrides the proxy target (e.g. http://localhost:8790) for local multi-stack testing.
 * - VITE_SERVER_URL (read by the client at runtime) overrides the API/WS base entirely (default: same origin).
 */
const target = process.env.VITE_PROXY_TARGET ?? 'http://localhost:8787';
const wsTarget = target.replace(/^http/, 'ws');

/** Heavy 3D libraries only. Anything shared with the main app (react, zustand) stays out of this chunk. */
const THREE_RE = /node_modules\/(three|@react-three|three-stdlib|three-mesh-bvh|troika-[^/]+|camera-controls|maath|meshline|stats-gl|detect-gpu|@monogrid|@mediapipe|@use-gesture|hls\.js|suspend-react|its-fine|react-use-measure|utility-types|draco3d|potpack|bidi-js|webgl-sdf-generator|tunnel-rat)\//;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target: wsTarget, ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target: wsTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // zod ships /*@__PURE__*/ annotations Rollup can't place; harmless noise from node_modules
        if (warning.code === 'INVALID_ANNOTATION' && /node_modules/.test(warning.id ?? '')) return;
        defaultHandler(warning);
      },
      output: {
        manualChunks(id) {
          if (THREE_RE.test(id)) return 'three';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
