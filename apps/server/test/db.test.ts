import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTING_COINS } from '@pixels/shared';
import { Accounts } from '../src/accounts';
import { Database, MAX_TOKENS_PER_ACCOUNT } from '../src/db';
import { silentLogger } from '../src/log';
import { createServer } from '../src/server';
import { makeClock, rmDir, tmpDir } from './helpers';

const dirs: string[] = [];
const fresh = () => {
  const d = tmpDir('pixels-db-');
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmDir(d);
});

function setup(dir: string, debounceMs = 5) {
  const clock = makeClock();
  const db = new Database({ dir, clock, logger: silentLogger, debounceMs });
  db.load();
  return { db, clock, accounts: new Accounts(db, clock, silentLogger) };
}

const files = (dir: string) => fs.readdirSync(dir).sort();

describe('persistence', () => {
  it('starts empty when there is no file and writes db.json on flush', async () => {
    const dir = fresh();
    const { db, accounts } = setup(dir);
    expect(db.accountCount).toBe(0);
    expect(files(dir)).toEqual([]);
    accounts.login('alice', 'a@example.com');
    await db.flush();
    expect(files(dir)).toEqual(['db.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).accounts).toHaveLength(1);
  });

  it('reloads everything: coins, inventory, equipped, claims, daily totals, active mission and tokens', async () => {
    const dir = fresh();
    const a = setup(dir);
    const r = a.accounts.login('alice', 'Alice@Example.com');
    if (!r.ok) throw new Error('login failed');
    const acc = r.account;
    acc.coins = 321;
    acc.inventory = { coffee: 3, explorer_cap: 1 };
    acc.equipped = { hat: 'explorer_cap' };
    acc.missionClaims = { m_one: 111 };
    acc.dailyRewards = { day: '2026-01-15', coins: 55 };
    acc.lastCompletedAt = { delivery: 999 };
    acc.lastPos = { x: 3, z: 4, ry: 1, at: 1234 };
    acc.activeMission = {
      id: 'm_x',
      type: 'delivery',
      title: 'T',
      description: 'D',
      objectives: [{ id: 'bakery', kind: 'pickup', label: 'p', done: true }, { id: 'cafe', kind: 'dropoff', label: 'd', done: false }],
      current: 1,
      startedAt: 10,
      expiresAt: 20,
    };
    a.db.save();
    await a.db.close();

    const b = setup(dir);
    const back = b.db.getAccount(acc.id)!;
    expect(back).toEqual(acc);
    expect(back.email).toBe('alice@example.com');
    // lookups work after reload
    expect(b.db.findByEmail('alice@example.com')).toBe(back);
    expect(b.accounts.authenticate(r.token)).toBe(back);
    expect(b.db.tagTaken('ALICE', acc.tag)).toBe(true);
  });

  it('debounces writes: nothing immediately, one write shortly after', async () => {
    const dir = fresh();
    const { db, accounts } = setup(dir, 40);
    accounts.login('alice', 'a@example.com');
    accounts.login('bobby', 'b@example.com');
    expect(fs.existsSync(path.join(dir, 'db.json'))).toBe(false);
    // poll rather than sleep a fixed time: the write is async and the machine may be busy
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if (JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).accounts.length === 2) break;
      } catch {
        /* not written yet */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).accounts).toHaveLength(2);
    await db.close();
  });

  it('writes atomically: no temp files left behind and the file is always complete JSON', async () => {
    const dir = fresh();
    const { db, accounts } = setup(dir);
    for (let i = 0; i < 20; i++) {
      accounts.login('user' + i, `u${i}@example.com`);
      void db.flush();
    }
    await db.flush();
    expect(files(dir)).toEqual(['db.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).accounts).toHaveLength(20);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'db.json')).mode & 0o077).toBe(0);
  });

  it('flushSync persists without awaiting', () => {
    const dir = fresh();
    const { db, accounts } = setup(dir, 10_000);
    accounts.login('alice', 'a@example.com');
    db.flushSync();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).accounts).toHaveLength(1);
    expect(files(dir)).toEqual(['db.json']);
  });

  it('a server restart keeps accounts (same email => same account, same display name)', async () => {
    const dir = fresh();
    const s1 = createServer({ dataDir: dir, logger: silentLogger, timers: false });
    const r1 = s1.accounts.login('alice', 'a@example.com');
    if (!r1.ok) throw new Error('x');
    await s1.stop();
    const s2 = createServer({ dataDir: dir, logger: silentLogger, timers: false });
    const r2 = s2.accounts.login('somethingelse', 'A@EXAMPLE.COM');
    if (!r2.ok) throw new Error('x');
    expect(r2.created).toBe(false);
    expect(r2.account.id).toBe(r1.account.id);
    expect(r2.account.displayName).toBe(r1.account.displayName);
    expect(r2.account.coins).toBe(STARTING_COINS);
    await s2.stop();
  });
});

describe('tolerating bad files', () => {
  it('starts fresh and keeps a backup when the file is not JSON', async () => {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, 'db.json'), '{"accounts": [ {"id": "a", ');
    const { db, accounts } = setup(dir);
    expect(db.accountCount).toBe(0);
    const backups = files(dir).filter((f) => f.startsWith('db.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toContain('"id": "a"');
    // and the database is usable and later writes do not clobber the backup
    accounts.login('alice', 'a@example.com');
    await db.close();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).accounts).toHaveLength(1);
    expect(files(dir).filter((f) => f.startsWith('db.json.corrupt-'))).toHaveLength(1);
  });

  it.each([
    ['empty file', ''],
    ['wrong top-level shape', '{"accounts": 5}'],
    ['array instead of object', '[]'],
    ['null', 'null'],
  ])('starts fresh for %s', (_name, content) => {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, 'db.json'), content);
    const { db } = setup(dir);
    expect(db.accountCount).toBe(0);
    expect(files(dir).some((f) => f.startsWith('db.json.corrupt-'))).toBe(true);
  });

  it('keeps valid accounts, drops invalid ones (and backs the file up); fills defaults for older records', async () => {
    const dir = fresh();
    const good = { id: 'g1', email: 'G@Example.com', username: 'good', tag: '0001', displayName: 'good#0001', coins: 7 };
    const bad = { id: 'b1', email: 'b@example.com', username: 'bad', tag: 'xx', displayName: 'bad#xx' };
    const dupeEmail = { ...good, id: 'g2' };
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, accounts: [good, bad, dupeEmail, 42] }));
    const { db } = setup(dir);
    expect(db.accountCount).toBe(1);
    const acc = db.getAccount('g1')!;
    expect(acc.email).toBe('g@example.com');
    expect(acc.coins).toBe(7);
    expect(acc).toMatchObject({ inventory: {}, equipped: {}, tokens: [], missionClaims: {}, activeMission: null, lastPos: null, wallet: null, dailyRewards: { day: '', coins: 0 } });
    expect(files(dir).some((f) => f.startsWith('db.json.corrupt-'))).toBe(true);
    await db.close();
  });

  it('ignores unknown equip slots in stored data', () => {
    const dir = fresh();
    const acc = { id: 'g1', email: 'g@example.com', username: 'good', tag: '0001', displayName: 'good#0001', equipped: { hat: 'explorer_cap', cape: 'x' } };
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ accounts: [acc] }));
    const { db } = setup(dir);
    expect(db.getAccount('g1')!.equipped).toEqual({ hat: 'explorer_cap' });
  });
});

describe('tokens', () => {
  it('stores only the sha256 of the token, never the token itself', async () => {
    const dir = fresh();
    const { db, accounts } = setup(dir);
    const r = accounts.login('alice', 'a@example.com');
    if (!r.ok) throw new Error('x');
    await db.flush();
    const raw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(raw).not.toContain(r.token);
    const { createHash } = await import('node:crypto');
    expect(raw).toContain(createHash('sha256').update(r.token).digest('hex'));
  });

  it(`keeps several tokens per account (multi-device) but at most ${MAX_TOKENS_PER_ACCOUNT}, dropping the oldest`, () => {
    const dir = fresh();
    const { accounts } = setup(dir);
    const tokens: string[] = [];
    for (let i = 0; i < MAX_TOKENS_PER_ACCOUNT + 2; i++) {
      const r = accounts.login('alice', 'a@example.com');
      if (!r.ok) throw new Error('x');
      tokens.push(r.token);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
    const valid = tokens.map((t) => accounts.authenticate(t) !== null);
    expect(valid).toEqual([false, false, true, true, true, true, true]);
  });

  it('rejects malformed tokens without hashing surprises', () => {
    const dir = fresh();
    const { accounts } = setup(dir);
    accounts.login('alice', 'a@example.com');
    for (const t of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), undefined, null]) {
      expect(accounts.authenticate(t as string)).toBeNull();
    }
  });
});
