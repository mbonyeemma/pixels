import { existsSync, mkdirSync, readFileSync, copyFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EQUIP_SLOTS, type Equipped, type MissionType } from '@pixels/shared';
import { silentLogger, type Logger } from './log';
import { systemClock, type Clock } from './util';

export const MAX_TOKENS_PER_ACCOUNT = 5;
const MAX_CLAIM_LEDGER = 500;

export interface TokenRecord {
  /** sha256 hex of the bearer token. The raw token is never stored. */
  hash: string;
  createdAt: number;
}

export interface ActiveMissionObjective {
  /** location id (== interact target) */
  id: string;
  kind: 'goto' | 'pickup' | 'dropoff' | 'collect';
  label: string;
  done: boolean;
}

export interface ActiveMissionRecord {
  /** unique mission instance id; recorded in the claim ledger on completion */
  id: string;
  type: MissionType;
  title: string;
  description: string;
  objectives: ActiveMissionObjective[];
  current: number;
  startedAt: number;
  expiresAt: number;
}

export interface AccountRecord {
  id: string;
  /** lower-cased; the account key */
  email: string;
  username: string;
  tag: string;
  displayName: string;
  coins: number;
  inventory: Record<string, number>;
  equipped: Equipped;
  tokens: TokenRecord[];
  createdAt: number;
  lastLoginAt: number;
  lastSeenAt: number;
  lastPos: { x: number; z: number; ry: number; at: number } | null;
  /** mission instance id -> claim time. A mission can pay out at most once. */
  missionClaims: Record<string, number>;
  /** coins earned from missions on the given UTC day */
  dailyRewards: { day: string; coins: number };
  /** per mission type: when the last reward was paid out (for cooldowns) */
  lastCompletedAt: Partial<Record<MissionType, number>>;
  activeMission: ActiveMissionRecord | null;
  wallet: string | null;
}

/** A server-issued, single-purpose payment request (optional Solana Devnet payments). */
export interface PaymentIntentRecord {
  id: string;
  accountId: string;
  itemId: string;
  /** amount taken from the server catalogue at creation time */
  lamports: number;
  /** the account's linked wallet at creation time: the only wallet allowed to pay for this intent */
  payer: string;
  treasury: string;
  /** random one-time public key (base58) that must appear in the payment transaction */
  reference: string;
  memo: string;
  createdAt: number;
  /** payment deadline */
  expiresAt: number;
  /** `paid_not_granted`: verified on-chain but the item could not be granted (needs a manual refund) */
  status: 'pending' | 'fulfilled' | 'paid_not_granted';
  /** set once settled */
  signature?: string;
  fulfilledAt?: number;
  slot?: number;
}

/** Ledger of transaction signatures that have been used to settle an intent: a signature can only ever be used once. */
export interface UsedSignatureRecord {
  signature: string;
  intentId: string;
  accountId: string;
  at: number;
  slot?: number;
  lamports?: number;
  /** `paid_not_granted`: verified on-chain but the item could not be granted (e.g. already owned); needs a manual refund */
  outcome: 'granted' | 'paid_not_granted';
}

const IntentSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  itemId: z.string().min(1),
  lamports: z.number().int().positive(),
  payer: z.string().min(1),
  treasury: z.string().min(1),
  reference: z.string().min(1),
  memo: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(['pending', 'fulfilled', 'paid_not_granted']),
  signature: z.string().optional(),
  fulfilledAt: z.number().optional(),
  slot: z.number().optional(),
});
const UsedSignatureSchema = z.object({
  signature: z.string().min(1),
  intentId: z.string().min(1),
  accountId: z.string().min(1),
  at: z.number(),
  slot: z.number().optional(),
  lamports: z.number().optional(),
  outcome: z.enum(['granted', 'paid_not_granted']).default('granted'),
});
const PaymentsFileSchema = z.object({ intents: z.array(z.unknown()).default([]), signatures: z.array(z.unknown()).default([]) });

/** Pending intents are dropped this long after they expired (fulfilled intents are kept as receipts). */
const INTENT_RETENTION_MS = 24 * 60 * 60_000;

const MissionTypeSchema = z.enum(['visit_location', 'delivery', 'treasure_hunt']);
const ActiveMissionSchema = z.object({
  id: z.string().min(1),
  type: MissionTypeSchema,
  title: z.string(),
  description: z.string(),
  objectives: z.array(
    z.object({ id: z.string(), kind: z.enum(['goto', 'pickup', 'dropoff', 'collect']), label: z.string(), done: z.boolean() }),
  ),
  current: z.number().int().min(0),
  startedAt: z.number(),
  expiresAt: z.number(),
});

const AccountSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(3),
  username: z.string().min(1),
  tag: z.string().regex(/^\d{4}$/),
  displayName: z.string().min(1),
  coins: z.number().int().min(0).default(0),
  inventory: z.record(z.string(), z.number().int().min(0)).default({}),
  equipped: z.record(z.string(), z.string()).default({}),
  tokens: z.array(z.object({ hash: z.string(), createdAt: z.number() })).default([]),
  createdAt: z.number().default(0),
  lastLoginAt: z.number().default(0),
  lastSeenAt: z.number().default(0),
  lastPos: z.object({ x: z.number(), z: z.number(), ry: z.number(), at: z.number() }).nullable().default(null),
  missionClaims: z.record(z.string(), z.number()).default({}),
  dailyRewards: z.object({ day: z.string(), coins: z.number() }).default({ day: '', coins: 0 }),
  lastCompletedAt: z.record(z.string(), z.number()).default({}),
  activeMission: ActiveMissionSchema.nullable().default(null),
  wallet: z.string().nullable().default(null),
});

const FileSchema = z.object({ version: z.number().optional(), accounts: z.array(z.unknown()), payments: z.unknown().optional() });

function normalizeAccount(raw: z.infer<typeof AccountSchema>): AccountRecord {
  const equipped: Equipped = {};
  for (const slot of EQUIP_SLOTS) {
    const v = raw.equipped[slot];
    if (typeof v === 'string') equipped[slot] = v;
  }
  const lastCompletedAt: Partial<Record<MissionType, number>> = {};
  for (const t of ['visit_location', 'delivery', 'treasure_hunt'] as const) {
    const v = raw.lastCompletedAt[t];
    if (typeof v === 'number') lastCompletedAt[t] = v;
  }
  return { ...raw, email: raw.email.trim().toLowerCase(), equipped, lastCompletedAt };
}

export interface DatabaseOptions {
  dir: string;
  clock?: Clock;
  logger?: Logger;
  /** write debounce; default 500 ms */
  debounceMs?: number;
}

/**
 * Tiny JSON-file database. All data lives in memory; `save()` schedules a debounced atomic write
 * (tmp file + fsync + rename) and `flush()` forces it. A missing or corrupt file starts a fresh database
 * (a corrupt file is first copied to `db.json.corrupt-<time>`).
 */
export class Database {
  readonly file: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly debounceMs: number;
  private accounts = new Map<string, AccountRecord>();
  private byEmail = new Map<string, string>();
  private byToken = new Map<string, string>();
  /** linked Solana wallet (base58 public key) -> account id */
  private byWallet = new Map<string, string>();
  private intents = new Map<string, PaymentIntentRecord>();
  private usedSignatures = new Map<string, UsedSignatureRecord>();
  /** lower-cased username -> tags in use */
  private tags = new Map<string, Set<string>>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: DatabaseOptions) {
    this.file = path.join(opts.dir, 'db.json');
    this.clock = opts.clock ?? systemClock;
    this.log = opts.logger ?? silentLogger;
    this.debounceMs = opts.debounceMs ?? 500;
  }

  /* ------------------------------------------------------------ loading */

  load(): void {
    mkdirSync(this.opts.dir, { recursive: true });
    if (!existsSync(this.file)) {
      this.log.info('db: no database file, starting fresh');
      return;
    }
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      this.log.error('db: cannot read database file, starting fresh', { err });
      this.backupCorrupt('unreadable');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log.error('db: database file is not valid JSON, starting fresh');
      this.backupCorrupt('invalid-json');
      return;
    }
    const top = FileSchema.safeParse(parsed);
    if (!top.success) {
      this.log.error('db: database file has an unexpected shape, starting fresh');
      this.backupCorrupt('bad-shape');
      return;
    }
    let dropped = 0;
    for (const rawAccount of top.data.accounts) {
      const r = AccountSchema.safeParse(rawAccount);
      if (!r.success) {
        dropped++;
        continue;
      }
      const acc = normalizeAccount(r.data);
      if (this.accounts.has(acc.id) || this.byEmail.has(acc.email)) {
        dropped++;
        continue;
      }
      this.index(acc);
    }
    if (dropped > 0) {
      this.log.warn('db: dropped invalid accounts while loading', { dropped });
      this.backupCorrupt('invalid-accounts');
    }
    // the payments section is parsed leniently: a damaged section must never cost players their accounts
    // (the damaged file is backed up, like invalid accounts, so the replay ledger can be recovered by hand)
    const payments = PaymentsFileSchema.safeParse(top.data.payments ?? {});
    const paymentsData = payments.success ? payments.data : { intents: [], signatures: [] };
    let droppedPayments = payments.success ? 0 : 1;
    for (const rawIntent of paymentsData.intents) {
      const r = IntentSchema.safeParse(rawIntent);
      if (r.success && this.accounts.has(r.data.accountId)) this.intents.set(r.data.id, r.data);
      else droppedPayments++;
    }
    for (const rawSig of paymentsData.signatures) {
      const r = UsedSignatureSchema.safeParse(rawSig);
      if (r.success) this.usedSignatures.set(r.data.signature, r.data);
      else droppedPayments++;
    }
    if (droppedPayments > 0) {
      this.log.warn('db: dropped unreadable payment records while loading', { dropped: droppedPayments });
      this.backupCorrupt('invalid-payments');
    }
    this.log.info('db: loaded', { accounts: this.accounts.size, intents: this.intents.size, signatures: this.usedSignatures.size });
  }

  private backupCorrupt(reason: string): void {
    try {
      const dest = `${this.file}.corrupt-${this.clock()}-${reason}`;
      copyFileSync(this.file, dest);
      this.log.warn('db: backed up problematic file', { dest: path.basename(dest) });
    } catch (err) {
      this.log.error('db: could not back up problematic file', { err });
    }
  }

  private index(acc: AccountRecord): void {
    this.accounts.set(acc.id, acc);
    this.byEmail.set(acc.email, acc.id);
    for (const t of acc.tokens) this.byToken.set(t.hash, acc.id);
    if (acc.wallet) {
      const owner = this.byWallet.get(acc.wallet);
      if (owner && owner !== acc.id) {
        // a wallet can belong to one account only: the first one loaded keeps it
        this.log.warn('db: wallet linked to two accounts, unlinking the later one', { account: acc.id });
        acc.wallet = null;
      } else {
        this.byWallet.set(acc.wallet, acc.id);
      }
    }
    const key = acc.username.toLowerCase();
    let used = this.tags.get(key);
    if (!used) this.tags.set(key, (used = new Set()));
    used.add(acc.tag);
  }

  /* ------------------------------------------------------------ queries */

  getAccount(id: string): AccountRecord | undefined {
    return this.accounts.get(id);
  }

  findByEmail(emailLower: string): AccountRecord | undefined {
    const id = this.byEmail.get(emailLower);
    return id ? this.accounts.get(id) : undefined;
  }

  findByTokenHash(hash: string): AccountRecord | undefined {
    const id = this.byToken.get(hash);
    return id ? this.accounts.get(id) : undefined;
  }

  findByWallet(publicKey: string): AccountRecord | undefined {
    const id = this.byWallet.get(publicKey);
    return id ? this.accounts.get(id) : undefined;
  }

  allAccounts(): AccountRecord[] {
    return [...this.accounts.values()];
  }

  get accountCount(): number {
    return this.accounts.size;
  }

  /** True when another account already uses this username+tag (usernames compare case-insensitively). */
  tagTaken(username: string, tag: string): boolean {
    return this.tags.get(username.toLowerCase())?.has(tag) ?? false;
  }

  /* ---------------------------------------------------------- mutations */

  insertAccount(acc: AccountRecord): void {
    this.index(acc);
    this.save();
  }

  /** Attach a token hash to an account, dropping the oldest tokens beyond the cap. */
  addToken(acc: AccountRecord, hash: string): void {
    acc.tokens.push({ hash, createdAt: this.clock() });
    this.byToken.set(hash, acc.id);
    while (acc.tokens.length > MAX_TOKENS_PER_ACCOUNT) {
      const old = acc.tokens.shift()!;
      this.byToken.delete(old.hash);
    }
    this.save();
  }

  /**
   * Link (or, with null, unlink) a wallet. Refuses a wallet that already belongs to another account.
   * Returns false when refused.
   */
  setWallet(acc: AccountRecord, publicKey: string | null): boolean {
    if (publicKey) {
      const owner = this.byWallet.get(publicKey);
      if (owner && owner !== acc.id) return false;
    }
    if (acc.wallet && this.byWallet.get(acc.wallet) === acc.id) this.byWallet.delete(acc.wallet);
    acc.wallet = publicKey;
    if (publicKey) this.byWallet.set(publicKey, acc.id);
    this.save();
    return true;
  }

  /* ----------------------------------------------------- payments ledger */

  getIntent(id: string): PaymentIntentRecord | undefined {
    return this.intents.get(id);
  }

  intentsOf(accountId: string): PaymentIntentRecord[] {
    return [...this.intents.values()].filter((i) => i.accountId === accountId);
  }

  putIntent(intent: PaymentIntentRecord): void {
    this.intents.set(intent.id, intent);
    this.save();
  }

  /** Drop pending intents that expired more than a day ago. Fulfilled intents are receipts and stay. */
  pruneIntents(now: number): void {
    let removed = false;
    for (const [id, i] of this.intents) {
      if (i.status === 'pending' && i.expiresAt + INTENT_RETENTION_MS < now) {
        this.intents.delete(id);
        removed = true;
      }
    }
    if (removed) this.save();
  }

  findSignature(signature: string): UsedSignatureRecord | undefined {
    return this.usedSignatures.get(signature);
  }

  recordSignature(rec: UsedSignatureRecord): void {
    this.usedSignatures.set(rec.signature, rec);
    this.save();
  }

  get signatureCount(): number {
    return this.usedSignatures.size;
  }

  /** Keep the claim ledger bounded (oldest entries first). */
  pruneClaims(acc: AccountRecord): void {
    const keys = Object.keys(acc.missionClaims);
    if (keys.length <= MAX_CLAIM_LEDGER) return;
    keys.sort((a, b) => acc.missionClaims[a] - acc.missionClaims[b]);
    for (const k of keys.slice(0, keys.length - MAX_CLAIM_LEDGER)) delete acc.missionClaims[k];
  }

  /* -------------------------------------------------------- persistence */

  /** Mark the database changed; a write happens after the debounce interval. */
  save(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writeNow().catch(() => undefined); // failures are logged and retried by the next save/flush
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private serialize(): string {
    return JSON.stringify({
      version: 1,
      savedAt: this.clock(),
      accounts: [...this.accounts.values()],
      payments: { intents: [...this.intents.values()], signatures: [...this.usedSignatures.values()] },
    });
  }

  private writeNow(): Promise<void> {
    if (this.inflight) {
      return this.inflight.then(() => (this.dirty ? this.writeNow() : undefined));
    }
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    const data = this.serialize();
    const p: Promise<void> = atomicWrite(this.file, data)
      .catch((err) => {
        this.dirty = true;
        this.log.error('db: write failed', { err });
        throw err;
      })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
    return p;
  }

  /** Write any pending changes now (async). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (let attempt = 0; attempt < 3 && (this.dirty || this.inflight); attempt++) {
      try {
        await (this.inflight ?? this.writeNow());
      } catch {
        /* retried below; logged in writeNow */
      }
    }
  }

  /** Synchronous last-resort flush (process exit). */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(this.opts.dir, { recursive: true });
      const tmp = `${this.file}.tmp-sync`;
      writeFileSync(tmp, this.serialize(), { mode: 0o600 });
      const fd = openSync(tmp, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      this.log.error('db: sync write failed', { err });
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
