// Payments smoke test (optional Solana Devnet feature) in a real headless browser against the REAL built server and
// web bundle. No Solana network is needed: a tiny local JSON-RPC server plays Devnet, and a fake Wallet-Standard wallet
// (injected into the page) plays Phantom, signing with a real ed25519 key. Run `npm run build` first.
//
//   node e2e/payments.mjs
//
// Phase A: payments OFF  -> nothing wallet-related appears and no wallet chunk is requested.
// Phase B: payments ON   -> connect, link (signMessage), pay with SOL (wallet-signed transaction), server verifies it
//                           against the mock node, inventory updates; rejection flow; sign in with wallet.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair, SystemInstruction, Transaction } from '@solana/web3.js';

const PORT = process.env.E2E_PORT ?? '8797';
const RPC_PORT = process.env.E2E_RPC_PORT ?? '8798';
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.E2E_OUT ?? 'e2e/out';
mkdirSync(OUT, { recursive: true });
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ mock Devnet node */
const chain = { txs: new Map(), methods: [] };
const rpcResult = (method, params) => {
  chain.methods.push(method);
  if (method === 'getGenesisHash') return DEVNET_GENESIS;
  if (method === 'getTransaction') return chain.txs.get(params[0]) ?? null;
  if (method === 'getLatestBlockhash') return { context: { slot: 1 }, value: { blockhash: bs58.encode(nacl.randomBytes(32)), lastValidBlockHeight: 1000 } };
  return null;
};
const rpcServer = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const q = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: rpcResult(q.method, q.params) }));
  });
});
await new Promise((r) => rpcServer.listen(Number(RPC_PORT), '127.0.0.1', r));

/* ------------------------------------------------------------------ the fake wallet (node side) */
const treasury = Keypair.generate();
function makeFakeWallet() {
  const kp = Keypair.generate();
  return { kp, address: kp.publicKey.toBase58(), rejectNext: false, lastChain: null, signed: 0, sent: 0 };
}
/** What a node returns for a confirmed transaction (jsonParsed), derived from the REAL transaction bytes the page built. */
function recordTransaction(tx) {
  const msg = tx.compileMessage();
  const keys = msg.accountKeys.map((k, i) => ({ pubkey: k.toBase58(), signer: msg.isAccountSigner(i), writable: msg.isAccountWritable(i), source: 'transaction' }));
  const [transfer, memo] = tx.instructions;
  const t = SystemInstruction.decodeTransfer(transfer);
  const lamports = Number(t.lamports);
  const pre = keys.map(() => 3_000_000_000);
  const post = [...pre];
  post[keys.findIndex((k) => k.pubkey === t.fromPubkey.toBase58())] -= lamports + 5000;
  post[keys.findIndex((k) => k.pubkey === t.toPubkey.toBase58())] += lamports;
  const signature = bs58.encode(tx.signature);
  chain.txs.set(signature, {
    slot: 300_000_000,
    blockTime: Math.floor(Date.now() / 1000),
    version: 'legacy',
    meta: { err: null, preBalances: pre, postBalances: post },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        instructions: [
          { program: 'system', programId: transfer.programId.toBase58(), parsed: { type: 'transfer', info: { source: t.fromPubkey.toBase58(), destination: t.toPubkey.toBase58(), lamports } } },
          { program: 'spl-memo', programId: memo.programId.toBase58(), parsed: new TextDecoder().decode(memo.data) },
        ],
      },
    },
  });
  return signature;
}

async function installFakeWallet(context, w) {
  await context.exposeFunction('__fwSignMessage', async (bytes) => {
    if (w.rejectNext) {
      w.rejectNext = false;
      return { error: 'User rejected the request.' };
    }
    w.signed++;
    return { signature: Array.from(nacl.sign.detached(Uint8Array.from(bytes), w.kp.secretKey)) };
  });
  await context.exposeFunction('__fwSend', async (chainName, bytes) => {
    if (w.rejectNext) {
      w.rejectNext = false;
      return { error: 'User rejected the request.' };
    }
    w.lastChain = chainName;
    const tx = Transaction.from(Buffer.from(bytes));
    tx.partialSign(w.kp); // the wallet adds the player's signature: this is the "approval"
    w.sent++;
    return { signature: Array.from(bs58.decode(recordTransaction(tx))) };
  });
  await context.addInitScript((pkBytes) => {
    const publicKey = Uint8Array.from(pkBytes);
    const b58 = (bytes) => {
      const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const digits = [0];
      for (const byte of bytes) {
        let carry = byte;
        for (let j = 0; j < digits.length; j++) {
          carry += digits[j] << 8;
          digits[j] = carry % 58;
          carry = (carry / 58) | 0;
        }
        while (carry > 0) {
          digits.push(carry % 58);
          carry = (carry / 58) | 0;
        }
      }
      let out = '';
      for (const byte of bytes) {
        if (byte === 0) out += '1';
        else break;
      }
      for (let i = digits.length - 1; i >= 0; i--) out += A[digits[i]];
      return out;
    };
    const account = { address: b58(publicKey), publicKey, chains: ['solana:devnet'], features: ['solana:signAndSendTransaction', 'solana:signMessage'] };
    const listeners = new Set();
    let accounts = [];
    const wallet = {
      version: '1.0.0',
      name: 'Fake Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSIjOTk0NWZmIi8+PC9zdmc+',
      chains: ['solana:devnet', 'solana:mainnet'],
      get accounts() {
        return accounts;
      },
      features: {
        'standard:connect': {
          version: '1.0.0',
          connect: async () => {
            accounts = [account];
            listeners.forEach((l) => l({ accounts }));
            return { accounts };
          },
        },
        'standard:disconnect': {
          version: '1.0.0',
          disconnect: async () => {
            accounts = [];
            listeners.forEach((l) => l({ accounts }));
          },
        },
        'standard:events': {
          version: '1.0.0',
          on: (_event, listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: async (...inputs) =>
            Promise.all(
              inputs.map(async ({ message }) => {
                const r = await window.__fwSignMessage(Array.from(message));
                if (r.error) throw new Error(r.error);
                return { signedMessage: message, signature: Uint8Array.from(r.signature) };
              }),
            ),
        },
        'solana:signAndSendTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signAndSendTransaction: async (...inputs) =>
            Promise.all(
              inputs.map(async ({ chain, transaction }) => {
                const r = await window.__fwSend(chain, Array.from(transaction));
                if (r.error) throw new Error(r.error);
                return { signature: Uint8Array.from(r.signature) };
              }),
            ),
        },
      },
    };
    const register = (api) => api.register(wallet);
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
  }, Array.from(w.kp.publicKey.toBytes()));
}

/* ------------------------------------------------------------------ server + browser helpers */
let server = null;
async function startServer(payments) {
  const dataDir = mkdtempSync(`${tmpdir()}/pixels-pay-e2e-`);
  server = spawn('node', ['apps/server/dist/index.js'], {
    env: {
      ...process.env,
      PORT,
      DATA_DIR: dataDir,
      STATIC_DIR: 'apps/web/dist',
      AI_PROVIDER: 'rules',
      LOG_LEVEL: 'warn',
      PAYMENTS_ENABLED: payments ? 'true' : 'false',
      SOLANA_TREASURY_PUBKEY: treasury.publicKey.toBase58(),
      SOLANA_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
      SOLANA_CONFIRMATION_TIMEOUT_MS: '8000',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await sleep(500);
  server = null;
}

const executablePath = process.env.E2E_CHROMIUM || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function newPage(name, wallet) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  if (wallet) await installFakeWallet(ctx, wallet);
  // the page talks to "Devnet" for the blockhash and genesis check: answer from the mock node (no internet in the sandbox)
  await ctx.route('https://api.devnet.solana.com/**', async (route) => {
    const q = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: q.id, result: rpcResult(q.method, q.params) }) });
  });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => {
    console.log(`[${name}] pageerror:`, e.message);
    failures++;
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebGL|GPU|swiftshader/i.test(m.text())) console.log(`[${name}] console.error:`, m.text().slice(0, 200));
  });
  return { page, ctx, requests };
}
async function enterTown(page, name, email) {
  await page.goto(BASE);
  await page.fill('input[name=username]', name);
  await page.fill('input[name=email]', email);
  await page.click('button[type=submit]');
  await page.waitForSelector('nav[aria-label="Game menu"]', { timeout: 90000 });
}
const openShopViaAi = async (page) => {
  const aiInput = page.locator('input[aria-label="Message to the Town Guide"], textarea[aria-label="Message to the Town Guide"]');
  if (!(await aiInput.isVisible().catch(() => false))) {
    await page.keyboard.press('KeyT');
    await aiInput.waitFor({ timeout: 8000 });
  }
  await aiInput.fill('Show me what I can buy'); // the AI opens the real shop dialog (the player still decides what to buy)
  await page.click('button[aria-label="Send message"]');
  await page.waitForSelector('#shop-title', { timeout: 20000 });
};
const me = async (token) => (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json();
const tokenOf = (page) => page.evaluate(() => localStorage.getItem('pixels.token'));
const walletChunks = (reqs) => reqs.filter((u) => /\/assets\/(ui|controller|WalletModal)-/.test(u));

try {
  /* ============================ Phase A: payments disabled (the default) ============================ */
  console.log('\n--- Phase A: PAYMENTS_ENABLED=false ---');
  await startServer(false);
  check('GET /api/config says disabled', JSON.stringify(await (await fetch(`${BASE}/api/config`)).json()) === JSON.stringify({ enabled: false, cluster: 'devnet' }));
  const off = await (await fetch(`${BASE}/api/pay/intent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
  check('pay endpoints answer 404 when disabled', off === 404, `status=${off}`);
  {
    const { page, requests, ctx } = await newPage('off', null);
    await page.goto(BASE);
    await page.waitForSelector('input[name=username]', { timeout: 30000 });
    await sleep(1200);
    check('login screen: no "Sign in with wallet"', (await page.locator('text=/Sign in with wallet/').count()) === 0);
    await enterTown(page, 'off_user', 'off@example.com');
    check('HUD: no Wallet button', (await page.locator('nav[aria-label="Game menu"] button[aria-label="Wallet"]').count()) === 0);
    await openShopViaAi(page);
    await sleep(500);
    check('shop: no SOL pay buttons', (await page.locator('text=/Pay .* SOL/').count()) === 0);
    check('no wallet chunk was requested', walletChunks(requests).length === 0, walletChunks(requests).join(','));
    await page.screenshot({ path: `${OUT}/pay-off-shop.png` });
    await ctx.close();
  }
  await stopServer();

  /* ============================ Phase B: payments enabled ============================ */
  console.log('\n--- Phase B: PAYMENTS_ENABLED=true (mock Devnet node + fake wallet) ---');
  await startServer(true);
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  check('GET /api/config says enabled + treasury', cfg.enabled === true && cfg.treasury === treasury.publicKey.toBase58() && cfg.cluster === 'devnet', JSON.stringify(cfg));

  const wallet = makeFakeWallet();
  const { page, requests } = await newPage('alice', wallet);
  await page.goto(BASE);
  await page.waitForSelector('text=/Sign in with wallet/', { timeout: 30000 }).then(() => check('login screen offers "Sign in with wallet"', true)).catch(() => check('login screen offers "Sign in with wallet"', false));
  check('wallet UI chunk loaded, Solana libraries NOT yet', walletChunks(requests).some((u) => /\/ui-/.test(u)) && !requests.some((u) => /controller-/.test(u)));
  await enterTown(page, 'alice_pay', 'alice_pay@example.com');
  const token = await tokenOf(page);

  // connect + link
  await page.click('nav[aria-label="Game menu"] button[aria-label="Wallet"]');
  await page.waitForSelector('text=/Connect a wallet/', { timeout: 20000 });
  check('Solana libraries load only when the wallet modal opens', requests.some((u) => /controller-/.test(u)));
  check('modal is labelled DEVNET TEST', (await page.locator('[role=dialog] >> text=/DEVNET TEST — no real value/').count()) > 0);
  await page.click('button:has-text("Fake Wallet")');
  await page.waitForSelector('text=/Connected wallet/', { timeout: 15000 });
  const short = `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`;
  check('connected state shows shortened key + DEVNET + Disconnect', (await page.locator(`.wallet-key:has-text("${short}")`).count()) === 1 && (await page.locator('button:has-text("Disconnect")').count()) === 1);
  await page.click('button:has-text("Link wallet")');
  await page.waitForSelector('pre.wallet-msg', { timeout: 15000 });
  const msg = await page.locator('pre.wallet-msg').innerText();
  check('the exact message to sign is shown (key, nonce, Devnet, free)', msg.includes(wallet.address) && /Nonce: [0-9a-f]{32}/.test(msg) && /Devnet/.test(msg) && /cannot move any funds/.test(msg));
  await page.click('button:has-text("Sign message to link")');
  await page.waitForSelector('text=/Linked\\. You can pay/', { timeout: 15000 }).then(() => check('wallet linked after signMessage', true)).catch(() => check('wallet linked after signMessage', false));
  check('server stored the link', (await me(token)).wallet === wallet.address);
  await page.screenshot({ path: `${OUT}/pay-wallet-modal.png` });
  await page.keyboard.press('Escape');
  check('wallet chip shows under the player name', (await page.locator(`.wallet-chip:has-text("${short}")`).count()) === 1);

  // pay with SOL
  await openShopViaAi(page);
  const pixelCard = page.locator('li.shop-card', { hasText: 'Genesis Pixel' });
  await pixelCard.locator('button:has-text("Pay 0.01 SOL (Devnet test)")').waitFor({ timeout: 15000 });
  check('shop shows the Devnet pay button only on lamport-priced items', (await page.locator('button:has-text("(Devnet test)")').count()) === 3 && (await page.locator('li.shop-card', { hasText: 'Pixel Coffee' }).locator('text=/SOL/').count()) === 0);
  await page.screenshot({ path: `${OUT}/pay-shop.png` });

  // a rejection in the wallet changes nothing
  wallet.rejectNext = true;
  const hoodie = page.locator('li.shop-card', { hasText: 'Sunset Hoodie' });
  await hoodie.locator('button:has-text("(Devnet test)")').click();
  await hoodie.locator('text=/declined the request/').waitFor({ timeout: 20000 }).then(() => check('wallet rejection shows a friendly message', true)).catch(() => check('wallet rejection shows a friendly message', false));
  check('nothing granted after rejection', !((await me(token)).inventory.sunset_hoodie));

  await pixelCard.locator('button:has-text("Pay 0.01 SOL (Devnet test)")').click();
  await pixelCard.locator('text=/Verified on Solana Devnet/').waitFor({ timeout: 40000 }).then(() => check('payment verified by the server on-chain', true)).catch(() => check('payment verified by the server on-chain', false));
  const after = await me(token);
  check('inventory updated from the verified payment', after.inventory.genesis_pixel === 1, JSON.stringify(after.inventory));
  check('coins untouched (paid with SOL)', after.coins === 100);
  check('transaction was sent for the devnet chain', wallet.lastChain === 'solana:devnet', String(wallet.lastChain));
  check('server asked the node for the transaction', chain.methods.includes('getTransaction'));
  await pixelCard.locator('text=/Owned/').waitFor({ timeout: 8000 }).then(() => check('shop card shows Owned (realtime account message)', true)).catch(() => check('shop card shows Owned (realtime account message)', false));
  await page.screenshot({ path: `${OUT}/pay-success.png` });
  check('pay button is gone/disabled once owned', (await pixelCard.locator('button:has-text("(Devnet test)"):not([disabled])').count()) === 0);

  // sign in with the linked wallet on a fresh browser profile (no token)
  const { page: p2, ctx: c2 } = await newPage('alice-wallet-signin', wallet);
  await p2.goto(BASE);
  await p2.click('text=/Sign in with wallet/');
  await p2.waitForSelector('text=/Connect a wallet/', { timeout: 20000 });
  await p2.click('button:has-text("Fake Wallet")');
  await p2.waitForSelector('pre.wallet-msg', { timeout: 15000 });
  await p2.click('button.btn--primary:has-text("Sign in with wallet")');
  await p2.waitForSelector('nav[aria-label="Game menu"]', { timeout: 90000 }).then(() => check('sign in with a linked wallet enters the town', true)).catch(() => check('sign in with a linked wallet enters the town', false));
  const t2 = await tokenOf(p2);
  check('wallet sign-in is the same account (item still owned)', !!t2 && (await me(t2)).inventory.genesis_pixel === 1);
  await c2.close();

  // an unknown wallet gets a helpful message
  const stranger = makeFakeWallet();
  const { page: p3, ctx: c3 } = await newPage('stranger', stranger);
  await p3.goto(BASE);
  await p3.click('text=/Sign in with wallet/');
  await p3.click('button:has-text("Fake Wallet")');
  await p3.waitForSelector('pre.wallet-msg', { timeout: 15000 });
  await p3.click('button.btn--primary:has-text("Sign in with wallet")');
  await p3.waitForSelector('text=/create an account/i', { timeout: 15000 }).then(() => check('unknown wallet: helpful "create an account first" message', true)).catch(() => check('unknown wallet: helpful "create an account first" message', false));
  await p3.screenshot({ path: `${OUT}/pay-unknown-wallet.png` });
  await c3.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser.close().catch(() => undefined);
  await stopServer();
  rpcServer.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall payments checks passed');
process.exit(failures ? 1 : 0);
