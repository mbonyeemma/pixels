import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map', '.wasm', '.gltf', '.webmanifest']);

interface Cached {
  etag: string;
  gz: Buffer;
}

/**
 * Static file server for the built web app, with SPA fallback to index.html, path-traversal protection,
 * ETag/304 and (cached) gzip. Returns true when it handled the response.
 */
export function createStaticHandler(rootDir: string) {
  const root = path.resolve(rootDir);
  const gzCache = new Map<string, Cached>();

  async function statFile(p: string) {
    try {
      const st = await fs.stat(p);
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  }

  async function serve(req: IncomingMessage, res: ServerResponse, file: string, st: { size: number; mtimeMs: number }, fallback: boolean) {
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string | number> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      // hashed build assets are immutable; index.html (and the SPA fallback) must always revalidate
      'Cache-Control': !fallback && file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let body: Buffer = await fs.readFile(file);
    const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && COMPRESSIBLE.has(ext) && body.length > 1024;
    if (wantsGzip) {
      let c = gzCache.get(file);
      if (!c || c.etag !== etag) {
        c = { etag, gz: await gzipAsync(body) };
        gzCache.set(file, c);
      }
      body = c.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel.includes('\0')) return false;
    const target = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (target !== root && !target.startsWith(root + path.sep)) return false;

    let file = target;
    if (rel.endsWith('/') || target === root) file = path.join(target, 'index.html');
    const st = await statFile(file);
    if (st) {
      await serve(req, res, file, st, false);
      return true;
    }
    // SPA fallback: only for extension-less paths (client-side routes), never for missing assets
    if (!path.extname(rel)) {
      const index = path.join(root, 'index.html');
      const ist = await statFile(index);
      if (ist) {
        await serve(req, res, index, ist, true);
        return true;
      }
    }
    return false;
  };
}
