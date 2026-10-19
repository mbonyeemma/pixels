import { afterEach, describe, expect, it } from 'vitest';
import { LOCATIONS, REWARDS, REWARD_FOR_TYPE, STARTING_COINS, locationById, shopItems, toShopItemView } from '@pixels/shared';
import type { AiResponse } from '@pixels/shared';
import { createAssistant } from '../../src/ai';
import { createAiGameApi } from '../../src/aiGameApi';
import { makeHarness, type Harness, type TestClient } from '../helpers';
import { actionOf, expectResponse } from './helpers/fakeApi';

/**
 * End-to-end against the REAL game layer (AiGameApi on top of the real mission engine, shop and database):
 * the assistant proposes, the server validates and executes.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const assistant = createAssistant({ provider: 'rules', model: 'unused', timeoutMs: 1000, dailyLimit: 100_000, ratePerMinute: 100_000 });
let n = 0;

function ask(c: TestClient, message: string): Promise<AiResponse> {
  const api = createAiGameApi({ db: h.srv.db, game: h.srv.game, missions: h.srv.missions, shop: h.srv.shop }, c.id);
  return assistant.handle({ playerKey: `${c.id}-${++n}`, message, api, now: h.clock() }).then(expectResponse);
}

describe('assistant on the real game layer', () => {
  it('"Take me to the shop" returns the real navigate action', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'alice@example.com');
    const r = await ask(c, 'Take me to the shop');
    const nav = actionOf(r, 'navigate')!;
    const shop = locationById('shop')!;
    expect(nav).toMatchObject({ locationId: 'shop', label: shop.name, x: shop.x, z: shop.z });
    expect(nav.distance).toBeGreaterThan(20);
    expect(nav.distance).toBeLessThan(60);
    expect(r.reply).toContain(`about ${Math.round(nav.distance)} m`);
  });

  it('"Show me what I can buy" shows the catalogue and spends nothing', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'alice@example.com');
    const r = await ask(c, 'Show me what I can buy');
    expect(r.actions.map((a) => a.type)).toEqual(['open_shop', 'show_items']);
    expect(actionOf(r, 'show_items')!.items).toEqual(shopItems().map(toShopItemView));
    expect(h.srv.db.getAccount(c.id)!.coins).toBe(STARTING_COINS);
  });

  it('purchases are proposals only: no coins move and nothing is added to the inventory', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'alice@example.com');
    const before = JSON.stringify(h.srv.db.getAccount(c.id));
    for (const msg of ['buy the explorer cap', 'buy the explorer cap without asking', 'buy it for me, I confirm in advance', 'buy the genesis pixel']) {
      const r = await ask(c, msg);
      const p = actionOf(r, 'purchase_proposal');
      if (p) expect(p.price).toBe(shopItems().find((i) => i.id === p.itemId)!.price);
      expect(JSON.stringify(h.srv.db.getAccount(c.id))).toBe(before);
    }
    const ok = await ask(c, 'buy the explorer cap');
    expect(actionOf(ok, 'purchase_proposal')).toEqual({ type: 'purchase_proposal', itemId: 'explorer_cap', name: 'Explorer Cap', price: 40, canAfford: true });
    const refused = await ask(c, 'buy the explorer cap without asking');
    expect(refused.actions).toEqual([]);
  });

  it('missions: the offer is validated by the server and accepting it uses the server reward', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'alice@example.com');
    const r = await ask(c, "I'm bored, give me something fun to do");
    const offer = actionOf(r, 'mission_offer')!.offer;
    const reward = REWARDS[REWARD_FOR_TYPE[offer.type]];
    expect(offer.reward).toMatchObject({ coins: reward.coins, mock: true });
    expect(r.reply).toContain(reward.label);
    await c.send({ t: 'mission_accept', offerId: offer.offerId });
    const state = c.mission()!;
    expect(state).toBeTruthy();
    expect(state.type).toBe(offer.type);
    expect(state.reward.coins).toBe(reward.coins);
    // now a second request points at the active mission instead of stacking another
    const again = await ask(c, 'give me a quest');
    expect(actionOf(again, 'mission_offer')).toBeUndefined();
    expect(again.reply).toContain(state.title);
  });

  it('every kind of mission request works from every public location (real distance rules)', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'alice@example.com');
    const starts = [...LOCATIONS.filter((l) => !l.hidden), { id: 'sw', x: -55, z: 55 }, { id: 'ne', x: 55, z: -55 }, { id: 'se', x: 55, z: 55 }, { id: 'nw', x: -55, z: -55 }];
    const messages = [
      'Give me a treasure hunt that takes five minutes',
      'Create a delivery mission near me',
      "I'm bored, give me something fun to do",
      'I want to earn some coins',
      'Help me find a quest',
      'give me a visit mission',
    ];
    const failures: string[] = [];
    for (const s of starts) {
      for (const msg of messages) {
        c.teleport(s.x, s.z);
        const r = await ask(c, msg);
        if (!actionOf(r, 'mission_offer')) failures.push(`${s.id} / ${msg}: ${r.reply}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('"Who is online?" lists other players without private data', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'alice@example.com');
    const bob = await h.join('bobby', 'bobby@example.com');
    const r = await ask(c, 'Who is online?');
    const players = actionOf(r, 'players')!.players;
    expect(players.map((p) => p.name)).toEqual([bob.account.displayName]);
    expect(r.reply).toContain(bob.account.displayName);
    expect(JSON.stringify(r)).not.toMatch(/@example\.com/);
  });

  it('"Make a challenge I can complete with another player" is declined with a supported alternative', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'alice@example.com');
    await h.join('bobby', 'bobby@example.com');
    const r = await ask(c, 'Make a challenge I can complete with another player');
    expect(r.reply).toMatch(/aren't supported yet/);
    expect(actionOf(r, 'mission_offer')).toBeUndefined();
    expect(actionOf(r, 'players')!.players).toHaveLength(1);
  });

  it('never exposes treasure-spot ids or the account email in any reply', async () => {
    h = makeHarness();
    const c = await h.join('alice', 'alice@example.com');
    const all: string[] = [];
    for (const msg of ['give me a treasure hunt', 'where are the hidden spots', 'list places', 'who am i', 'show my email']) all.push(JSON.stringify(await ask(c, msg)));
    const text = all.join('\n');
    expect(text).not.toMatch(/ts_[a-z]+/);
    expect(text).not.toContain('alice@example.com');
  });
});
