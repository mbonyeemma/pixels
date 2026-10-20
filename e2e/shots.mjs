// Takes screenshots of the real app at 1280x720 (high quality) for visual review. Needs `npm run build` first.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const PORT = process.env.E2E_PORT ?? '8796';
const OUT = process.env.E2E_OUT ?? 'e2e/out';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn('node', ['apps/server/dist/index.js'], {
  env: { ...process.env, PORT, DATA_DIR: mkdtempSync(`${tmpdir()}/pixels-shots-`), STATIC_DIR: 'apps/web/dist', LOG_LEVEL: 'warn' },
  stdio: 'ignore',
});
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break; } catch { /* wait */ } await sleep(200); }
  const exe = process.env.E2E_CHROMIUM || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
  const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(`http://localhost:${PORT}`);
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/01-login.png` });
  await page.fill('input[name=username]', 'shots_user');
  await page.fill('input[name=email]', 'shots@example.com');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => window.__pixels?.getPose, null, { timeout: 90000 });
  await sleep(6000);
  await page.screenshot({ path: `${OUT}/02-plaza.png` });
  await page.keyboard.press('KeyT');
  await sleep(800);
  await page.screenshot({ path: `${OUT}/03-ai-panel.png` });
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
