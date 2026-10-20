// Full-stack smoke test: builds must exist (npm run build). Starts the real server (serving apps/web/dist),
// logs two players in with headless Chromium, and checks movement, multiplayer, chat, AI guide, shop and missions.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const PORT = process.env.E2E_PORT ?? '8795';
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.E2E_OUT ?? 'e2e/out';
mkdirSync(OUT, { recursive: true });
const dataDir = mkdtempSync(`${tmpdir()}/pixels-e2e-`);
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', ['apps/server/dist/index.js'], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, STATIC_DIR: 'apps/web/dist', AI_PROVIDER: 'rules', LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const stop = async () => { server.kill('SIGTERM'); await sleep(300); };

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('server did not start');
}

async function login(browser, name, email) {
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.E2E_W ?? 640), height: Number(process.env.E2E_H ?? 400) } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`[${name}] pageerror:`, e.message); failures++; });
  await page.goto(BASE);
  await page.fill('input[name=username]', name);
  await page.fill('input[name=email]', email);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => window.__pixels?.getPose, null, { timeout: 60000 });
  // software GL is slow: use low quality so frame time stays near the 0.1 s dt clamp
  await page.click('button[title="Toggle graphics quality"]').catch(() => {});
  await sleep(1500);
  return page;
}
const fps = (page) => page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 > 2000) res(n / 2); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
const ensureAi = async (page, input) => { if (!(await input.isVisible().catch(() => false))) { await page.keyboard.press('KeyT'); await input.waitFor({ timeout: 5000 }); } };
const pose = (page) => page.evaluate(() => window.__pixels.getPose());

try {
  await waitHealth();
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const a = await login(browser, 'alice_e2e', 'alice@example.com');
  const b = await login(browser, 'bob_e2e', 'bob@example.com');
  console.log('fps (alice, low quality, software GL):', await fps(a));
  check('both players in the world', !!(await pose(a)) && !!(await pose(b)));

  // multiplayer presence
  await sleep(1500);
  const seenByA = await a.evaluate(() => window.__pixels.remotes().length);
  check('alice sees bob', seenByA >= 1, `remotes=${seenByA}`);

  // movement with WASD, observed remotely
  const before = await pose(a);
  await a.keyboard.down('KeyW');
  await sleep(2500);
  await a.keyboard.up('KeyW');
  const after = await pose(a);
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  check('WASD moves the avatar', moved > 1, `moved=${moved.toFixed(1)}m`);
  await sleep(800);
  const bobSeesAlice = await b.evaluate(() => window.__pixels.remotes());
  const remoteAlice = bobSeesAlice.find((r) => /alice_e2e/.test(r.name ?? ''));
  check('bob sees alice move', !!remoteAlice && Math.hypot(remoteAlice.x - after.x, remoteAlice.z - after.z) < 3, remoteAlice ? `at ${remoteAlice.x.toFixed(1)},${remoteAlice.z.toFixed(1)}` : 'not found');

  // chat
  await a.keyboard.press('Enter');
  await a.keyboard.type('hello from alice');
  await a.keyboard.press('Enter');
  await b.waitForSelector('text=hello from alice', { timeout: 8000 }).then(() => check('chat reaches bob', true)).catch(() => check('chat reaches bob', false));

  // AI guide: navigate to the shop, then open the shop with items
  await a.keyboard.press('Escape');
  const aiInput = a.locator('input[aria-label="Message to the Town Guide"], textarea[aria-label="Message to the Town Guide"]');
  await ensureAi(a, aiInput);
  await aiInput.fill('Take me to the shop');
  await a.click('button[aria-label="Send message"]');
  await a.waitForSelector('text=/Pixel Market/', { timeout: 15000 }).then(() => check('AI answers "Take me to the shop"', true)).catch(() => check('AI answers "Take me to the shop"', false));
  const start = await pose(a);
  await sleep(6000);
  const walked = await pose(a);
  check('AI auto-walk moves the avatar', Math.hypot(walked.x - start.x, walked.z - start.z) > 3);
  await a.screenshot({ path: `${OUT}/alice-ai-walk.png` });

  await ensureAi(a, aiInput);
  await aiInput.fill('Show me what I can buy');
  await a.click('button[aria-label="Send message"]');
  await a.waitForSelector('text=/Pixel Coffee/', { timeout: 15000 }).then(() => check('shop shows real catalogue', true)).catch(() => check('shop shows real catalogue', false));
  await a.screenshot({ path: `${OUT}/alice-shop.png` });
  await a.keyboard.press('Escape');

  // mission offer through the AI
  await ensureAi(a, aiInput);
  await aiInput.fill("I'm bored, give me something fun to do");
  await a.click('button[aria-label="Send message"]');
  const accept = a.locator('button:has-text("Accept")').first();
  await accept.waitFor({ timeout: 15000 }).then(() => check('AI offers a mission', true)).catch(() => check('AI offers a mission', false));
  if (await accept.count()) {
    await accept.click();
    await a.waitForSelector('text=/Abandon/', { timeout: 8000 }).then(() => check('mission tracker appears after accept', true)).catch(() => check('mission tracker appears after accept', false));
  }
  await a.screenshot({ path: `${OUT}/alice-mission.png` });
  await b.screenshot({ path: `${OUT}/bob.png` });

  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('health reports two players', health.players === 2, JSON.stringify(health));
  await browser.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await stop();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
