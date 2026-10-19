// Dev harness only: `npx vite --config apps/web/src/game/dev/vite.config.ts` then open /game-dev.html
// The real network client is swapped for a fake one ONLY inside this config; the app build is untouched.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../..');

const fakeNet = (): Plugin => ({
  name: 'pixels-fake-net-client',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer && /src[\\/]game[\\/]client\.ts$/.test(importer) && source === '../net/client') return path.resolve(here, 'fakeClient.ts');
    return null;
  },
});

export default defineConfig({
  root: webRoot,
  plugins: [fakeNet(), react()],
  server: { port: 5199, strictPort: true, host: '127.0.0.1', fs: { allow: [path.resolve(webRoot, '../..')] } },
  optimizeDeps: { include: ['three', '@react-three/fiber', '@react-three/drei', 'react', 'react-dom', 'zustand'] },
});
