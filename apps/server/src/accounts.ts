import { randomInt } from 'node:crypto';
import { STARTING_COINS, type AccountView } from '@pixels/shared';
import { MAX_TOKENS_PER_ACCOUNT, type AccountRecord, type Database } from './db';
import type { Logger } from './log';
import { emailKey, randomHex, sha256Hex, type Clock } from './util';

export { MAX_TOKENS_PER_ACCOUNT };

export type LoginResult =
  | { ok: true; token: string; account: AccountRecord; created: boolean }
  | { ok: false; status: number; error: string };

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Accounts: login (create-or-fetch by email), token auth, and the owner-facing view. */
export class Accounts {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /**
   * Log in or sign up. The email (case-insensitive) is the account key.
   * An existing email returns that account (the supplied username is ignored) with a fresh token.
   * Inputs must already be validated against LoginRequestSchema.
   */
  login(username: string, email: string): LoginResult {
    const key = emailKey(email);
    const now = this.clock();
    let account = this.db.findByEmail(key);
    let created = false;
    if (!account) {
      const tag = this.pickTag(username);
      if (!tag) return { ok: false, status: 409, error: 'That username is full. Please choose another one.' };
      account = {
        id: randomHex(8),
        email: key,
        username,
        tag,
        displayName: `${username}#${tag}`,
        coins: STARTING_COINS,
        inventory: {},
        equipped: {},
        tokens: [],
        createdAt: now,
        lastLoginAt: now,
        lastSeenAt: now,
        lastPos: null,
        missionClaims: {},
        dailyRewards: { day: '', coins: 0 },
        lastCompletedAt: {},
        activeMission: null,
        wallet: null,
      };
      this.db.insertAccount(account);
      created = true;
    }
    account.lastLoginAt = now;
    const token = randomHex(32);
    this.db.addToken(account, sha256Hex(token));
    this.log.info(created ? 'account created' : 'login', { account: account.id });
    return { ok: true, token, account, created };
  }

  /** Mint a fresh bearer token for an existing account (used by wallet sign-in). */
  issueToken(account: AccountRecord): string {
    const token = randomHex(32);
    account.lastLoginAt = this.clock();
    this.db.addToken(account, sha256Hex(token));
    this.log.info('login', { account: account.id, via: 'wallet' });
    return token;
  }

  /** Random unused 4-digit tag for this username (case-insensitive), or null if all 10000 are taken. */
  private pickTag(username: string): string | null {
    for (let i = 0; i < 60; i++) {
      const tag = String(randomInt(0, 10_000)).padStart(4, '0');
      if (!this.db.tagTaken(username, tag)) return tag;
    }
    // crowded username: scan sequentially from a random start
    const start = randomInt(0, 10_000);
    for (let i = 0; i < 10_000; i++) {
      const tag = String((start + i) % 10_000).padStart(4, '0');
      if (!this.db.tagTaken(username, tag)) return tag;
    }
    return null;
  }

  /** Resolve a bearer token to its account. */
  authenticate(token: string | null | undefined): AccountRecord | null {
    if (!token || !TOKEN_RE.test(token)) return null;
    return this.db.findByTokenHash(sha256Hex(token)) ?? null;
  }

  /** Extract the token from an `Authorization: Bearer ...` header. */
  authenticateHeader(header: string | undefined): AccountRecord | null {
    if (!header) return null;
    const m = /^Bearer\s+([0-9a-fA-F]{64})\s*$/.exec(header);
    return m ? this.authenticate(m[1].toLowerCase()) : null;
  }

  view(a: AccountRecord): AccountView {
    return {
      id: a.id,
      username: a.username,
      tag: a.tag,
      displayName: a.displayName,
      email: a.email,
      coins: a.coins,
      inventory: { ...a.inventory },
      equipped: { ...a.equipped },
      wallet: a.wallet,
    };
  }
}
