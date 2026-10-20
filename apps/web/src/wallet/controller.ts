/**
 * The wallet controller. EVERYTHING that touches a Solana library lives behind this module, which the app only ever
 * loads with a dynamic import() once payments are enabled and the player asks for a wallet. The game itself never
 * imports it, so players without payments (or without a wallet) download none of this code.
 *
 * Safety rules implemented here:
 *  - the player's own wallet signs everything; nothing is ever auto-approved and no key material is handled;
 *  - the price and the treasury come from the server and are cross-checked against the shared catalogue / config;
 *  - the transaction is sent for the Devnet chain only (the adapter derives the chain from our Devnet endpoint);
 *  - an item is shown as bought only after the server verified the payment on-chain.
 */
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { StandardWalletAdapter } from '@solana/wallet-standard-wallet-adapter-base';
import { isWalletAdapterCompatibleStandardWallet, type WalletAdapterCompatibleStandardWallet } from '@solana/wallet-adapter-base';
import { getWallets } from '@wallet-standard/app';
import { DEVNET_GENESIS_HASH, DEVNET_LABEL, hasLamportPrice, itemById } from '@pixels/shared';
import { useGame } from '../state';
import { adoptLogin } from '../net/client';
import { readJson } from '../net/http';
import { safeGet, safeSet } from '../net/storage';
import { apiUrl } from '../net/urls';
import * as api from './api';
import { clientRpc } from './cluster';
import { usePaymentConfig } from './config';
import { formatSol, shortenAddress } from './format';
import { RECOMMENDED_WALLETS, describeWalletError } from './walletErrors';
import { clearPending, pendingPayments, savePending } from './pending';
import { isPayBusy, useWallet, type PayPhase, type WalletInfo, type WalletState } from './store';
import { buildPaymentTransaction, type Web3Like } from './tx';

// some wallet/web3 code paths expect a global Buffer in browsers
if (typeof globalThis !== 'undefined' && !(globalThis as { Buffer?: unknown }).Buffer) (globalThis as { Buffer?: unknown }).Buffer = Buffer;

const LAST_WALLET_KEY = 'pixels.wallet';
const CONFIRM_ATTEMPTS = 40;
const CONFIRM_DELAY_MS = 2500;

let adapter: StandardWalletAdapter | null = null;
let inited = false;

const ui = () => useWallet.getState();
const patch = (p: Partial<WalletState>) => useWallet.setState(p);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ discovery */

function standardWallets(): WalletAdapterCompatibleStandardWallet[] {
  try {
    return getWallets().get().filter(isWalletAdapterCompatibleStandardWallet);
  } catch {
    return [];
  }
}

function refreshWallets(): void {
  const found: WalletInfo[] = standardWallets().map((w) => ({ name: w.name, icon: w.icon, installed: true }));
  const missing: WalletInfo[] = RECOMMENDED_WALLETS.filter((r) => !found.some((f) => f.name.toLowerCase().includes(r.name.toLowerCase()))).map((r) => ({
    name: r.name,
    installed: false,
    url: r.url,
  }));
  patch({ wallets: [...found, ...missing] });
}

/** Start listening for wallets (extensions can register after page load). Idempotent. */
export function init(): void {
  if (!inited) {
    inited = true;
    try {
      const reg = getWallets();
      reg.on('register', refreshWallets); // the registry lives as long as the page: no need to unsubscribe
      reg.on('unregister', refreshWallets);
    } catch {
      /* no registry available: the wallet list simply stays empty */
    }
  }
  refreshWallets();
}

/* ------------------------------------------------------------------ connection */

function onAdapterDisconnect(): void {
  adapter = null;
  patch({ connectedName: null, publicKey: null, challenge: null, busy: null });
}

export async function connect(name: string): Promise<boolean> {
  init();
  const wallet = standardWallets().find((w) => w.name === name);
  if (!wallet) {
    patch({ error: 'That wallet is not installed or not ready in this browser. Install it, reload this page and try again.' });
    return false;
  }
  patch({ busy: 'connecting', error: null, challenge: null });
  try {
    if (adapter) {
      adapter.off('disconnect', onAdapterDisconnect);
      await adapter.disconnect().catch(() => undefined);
      adapter = null;
    }
    const a = new StandardWalletAdapter({ wallet });
    a.on('disconnect', onAdapterDisconnect);
    await a.connect();
    if (!a.publicKey) throw new Error('The wallet did not share a public key.');
    adapter = a;
    safeSet(LAST_WALLET_KEY, name);
    patch({ connectedName: name, publicKey: a.publicKey.toBase58(), busy: null });
    return true;
  } catch (err) {
    patch({ busy: null, error: describeWalletError(err).message });
    return false;
  }
}

/** Reconnect silently (no popup) to the wallet used last time, if it is still authorised. */
export async function tryAutoConnect(): Promise<void> {
  if (adapter || ui().busy) return;
  const last = safeGet(LAST_WALLET_KEY);
  const wallet = last ? standardWallets().find((w) => w.name === last) : undefined;
  if (!wallet) return;
  try {
    const a = new StandardWalletAdapter({ wallet });
    a.on('disconnect', onAdapterDisconnect);
    await a.autoConnect();
    if (a.publicKey) {
      adapter = a;
      patch({ connectedName: wallet.name, publicKey: a.publicKey.toBase58() });
    }
  } catch {
    /* not pre-authorised: the player connects manually */
  }
}

export async function disconnect(): Promise<void> {
  const a = adapter;
  adapter = null;
  safeSet(LAST_WALLET_KEY, '');
  patch({ connectedName: null, publicKey: null, challenge: null, error: null, busy: null });
  if (a) {
    a.off('disconnect', onAdapterDisconnect);
    await a.disconnect().catch(() => undefined);
  }
}

/* --------------------------------------------------------- link / sign in */

/** Step 1: ask the server for the exact message to sign and show it to the player. */
export async function prepareChallenge(purpose: 'link' | 'signin'): Promise<void> {
  const pk = ui().publicKey;
  if (!pk || !adapter) {
    patch({ error: 'Connect a wallet first.' });
    return;
  }
  patch({ busy: 'challenge', error: null, challenge: null });
  const r = await api.requestChallenge(pk);
  if (!r.ok) {
    patch({ busy: null, error: r.error });
    return;
  }
  patch({ busy: null, challenge: { nonce: r.data.nonce, message: r.data.message, expiresAt: r.data.expiresAt, purpose } });
}

export function cancelChallenge(): void {
  patch({ challenge: null, error: null });
}

/** Step 2: the wallet signs the shown message (a free signature, no transaction); the server verifies and links / signs in. */
export async function signChallenge(): Promise<void> {
  const ch = ui().challenge;
  const pk = ui().publicKey;
  if (!ch || !pk || !adapter) return;
  if (!adapter.signMessage) {
    patch({ error: 'This wallet cannot sign messages. Try Phantom, Solflare or Backpack.' });
    return;
  }
  patch({ busy: 'signing', error: null });
  let signature: string;
  try {
    const bytes = await adapter.signMessage(new TextEncoder().encode(ch.message));
    signature = bs58.encode(bytes);
  } catch (err) {
    patch({ busy: null, error: describeWalletError(err).message });
    return;
  }
  patch({ busy: 'verifying' });
  const token = ch.purpose === 'link' ? useGame.getState().token : null;
  if (ch.purpose === 'link' && !token) {
    patch({ busy: null, error: 'Sign in to your Pixels account first.' });
    return;
  }
  const r = await api.verifyWallet({ publicKey: pk, signature, nonce: ch.nonce }, token);
  if (!r.ok) {
    patch({ busy: null, challenge: null, error: r.error });
    return;
  }
  patch({ busy: null, challenge: null, error: null });
  if (r.data.mode === 'signin' && r.data.token) {
    patch({ open: false });
    adoptLogin(r.data.token, r.data.account);
    return;
  }
  const st = useGame.getState();
  if (st.account) useGame.setState({ account: { ...st.account, wallet: r.data.account.wallet ?? pk } });
  st.toast(`Wallet ${shortenAddress(pk)} linked to your account. ${DEVNET_LABEL}.`, 'info');
}

export async function unlink(): Promise<void> {
  const st = useGame.getState();
  if (!st.token || !st.account) return;
  patch({ busy: 'unlinking', error: null });
  const r = await api.unlinkWallet(st.token);
  patch({ busy: null });
  if (!r.ok) {
    patch({ error: r.error });
    return;
  }
  const cur = useGame.getState().account;
  if (cur) useGame.setState({ account: { ...cur, wallet: null } });
  useGame.getState().toast('Wallet unlinked from your account.', 'info');
}

/* ------------------------------------------------------------------ paying */

const web3: Web3Like = { PublicKey, SystemProgram, Transaction, TransactionInstruction } as unknown as Web3Like;

function setPay(itemId: string, phase: PayPhase, message: string, signature?: string): void {
  ui().setPay(itemId, { phase, message, signature });
}

async function refreshAccount(): Promise<void> {
  const token = useGame.getState().token;
  if (!token) return;
  try {
    const res = await fetch(apiUrl('/api/me'), { headers: { Authorization: `Bearer ${token}` } });
    const data = (await readJson(res)) as (ReturnType<typeof useGame.getState>['account'] & object) | null;
    if (res.ok && data && typeof data.id === 'string') useGame.setState({ account: data });
  } catch {
    /* the realtime `account` message normally updates the inventory anyway */
  }
}

/** Ask the server to verify the transaction until it says yes, no, or we run out of patience. */
async function confirmLoop(itemId: string, intentId: string, signature: string, attempts = CONFIRM_ATTEMPTS): Promise<void> {
  const token = useGame.getState().token;
  if (!token) return;
  const name = itemById(itemId)?.name ?? 'your item';
  for (let i = 0; i < attempts; i++) {
    setPay(itemId, 'confirming', i === 0 ? 'Payment sent. Waiting for Solana Devnet to confirm it…' : `Still confirming on Devnet… (${i + 1})`, signature);
    const r = await api.confirmPayment(intentId, signature, token);
    if (r.ok) {
      clearPending(intentId);
      setPay(itemId, 'success', `Verified on Solana Devnet. ${name} is yours. ${DEVNET_LABEL}.`, signature);
      useGame.getState().toast(`Payment verified on Solana Devnet: you got ${name}. ${DEVNET_LABEL}.`, 'info');
      void refreshAccount();
      return;
    }
    const retryable = r.pending === true || r.status === 0 || r.status === 202 || r.status === 503 || r.code === 'rpc_unavailable' || r.code === 'pending';
    if (!retryable) {
      clearPending(intentId);
      setPay(itemId, 'failed', `${r.error} Nothing was added to your inventory.`, signature);
      return;
    }
    await sleep(CONFIRM_DELAY_MS);
  }
  // keep the pending record: it is retried the next time the shop opens
  setPay(itemId, 'failed', 'We could not confirm the payment yet. Your transaction was sent; it will be re-checked when you reopen the shop. Nothing was added to your inventory yet.', signature);
}

/** Pay for one item with Devnet SOL. The wallet shows its normal approval popup; the server decides if the item is granted. */
export async function pay(itemId: string): Promise<void> {
  const st = useGame.getState();
  const cfg = usePaymentConfig.getState().config;
  const item = itemById(itemId);
  if (isPayBusy(ui().pay[itemId])) return;
  if (!item || !hasLamportPrice(item) || !st.token || !st.account || !cfg?.enabled || !cfg.treasury) return;

  const needWallet = (hint: string) => patch({ open: true, mode: 'manage', hint, error: null });
  if (!st.account.wallet) return needWallet('Link a wallet to your account first, then you can pay with Devnet SOL.');
  await tryAutoConnect();
  const pk = ui().publicKey;
  if (!adapter || !pk) return needWallet(`Connect your linked wallet (${shortenAddress(st.account.wallet)}) to pay with Devnet SOL.`);
  if (pk !== st.account.wallet) {
    setPay(itemId, 'failed', `The connected wallet (${shortenAddress(pk)}) is not the wallet linked to your account (${shortenAddress(st.account.wallet)}). Connect the linked wallet instead.`);
    return;
  }

  setPay(itemId, 'preparing', 'Preparing your Devnet payment…');
  const created = await api.createPayIntent(itemId, st.token);
  if (!created.ok) return setPay(itemId, 'failed', created.error);
  const intent = created.data;
  // the server decides the price, but a mismatch with the shared catalogue or the config means something is off: stop
  if (intent.itemId !== itemId || intent.cluster !== 'devnet' || intent.treasury !== cfg.treasury || intent.lamports !== item.priceLamports) {
    return setPay(itemId, 'failed', 'The payment request did not match the shop price, so it was cancelled. Nothing was sent.');
  }

  let signature: string;
  try {
    const rpc = clientRpc();
    if (rpc.warning) console.warn('[wallet]', rpc.warning);
    const connection = new Connection(rpc.url, 'confirmed');
    try {
      const genesis = await connection.getGenesisHash();
      if (genesis !== DEVNET_GENESIS_HASH) return setPay(itemId, 'failed', 'The network check failed: the configured RPC is not Solana Devnet. Nothing was sent.');
    } catch {
      return setPay(itemId, 'failed', 'Could not reach Solana Devnet to prepare the payment. Check your connection and try again. Nothing was sent.');
    }
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = buildPaymentTransaction(web3, intent, pk, blockhash);
    setPay(itemId, 'wallet', `Approve the ${formatSol(intent.lamports)} SOL payment in your wallet. ${DEVNET_LABEL}.`);
    signature = await adapter.sendTransaction(tx as unknown as Transaction, connection, { preflightCommitment: 'confirmed' });
  } catch (err) {
    const info = describeWalletError(err);
    return setPay(itemId, 'failed', info.message);
  }

  savePending({ accountId: st.account.id, intentId: intent.intentId, itemId, signature, at: Date.now() });
  await confirmLoop(itemId, intent.intentId, signature);
}

/** Re-check payments that were sent but never confirmed (closed tab, network drop). */
export async function resumePending(): Promise<void> {
  const st = useGame.getState();
  if (!st.token || !st.account) return;
  for (const p of pendingPayments(st.account.id)) {
    if (isPayBusy(ui().pay[p.itemId])) continue;
    await confirmLoop(p.itemId, p.intentId, p.signature, 6);
  }
}
