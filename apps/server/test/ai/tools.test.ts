import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TREASURE_SPOT_IDS, shopItems, toShopItemView } from '@pixels/shared';
import { TOOL_DEFINITIONS, TOOL_NAMES, TOOL_SCHEMAS, ToolRunner, derivePlan } from '../../src/ai/tools';
import { createFakeApi } from './helpers/fakeApi';

const validMission = {
  title: 'Bread run',
  description: 'Carry fresh bread from the bakery to the cafe.',
  type: 'delivery',
  startLocationId: 'bakery',
  objectiveLocationIds: ['cafe'],
};

describe('tool allowlist definitions', () => {
  it('exposes exactly the ten allowlisted tools, each with a strict JSON schema', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect([...TOOL_NAMES].sort()).toEqual(
      ['find_location', 'find_players', 'get_player_context', 'list_available_quests', 'list_locations', 'list_shop_items', 'navigate_to', 'open_shop', 'propose_mission', 'propose_purchase'].sort(),
    );
    for (const def of TOOL_DEFINITIONS) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('JSON schemas and zod schemas agree on property names and required keys', () => {
    for (const def of TOOL_DEFINITIONS) {
      const js = z.toJSONSchema(TOOL_SCHEMAS[def.name as keyof typeof TOOL_SCHEMAS], { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, unknown>; required?: string[] };
      const declared = def.input_schema as { properties: Record<string, unknown>; required?: string[] };
      expect(Object.keys(declared.properties).sort(), def.name).toEqual(Object.keys(js.properties ?? {}).sort());
      expect([...(declared.required ?? [])].sort(), def.name).toEqual([...(js.required ?? [])].sort());
    }
  });

  it('no tool can carry a reward, price, amount or confirmation', () => {
    const forbidden = /reward|price|amount|coins|confirm|cost|wallet|sign|buy/i;
    for (const def of TOOL_DEFINITIONS) {
      const props = Object.keys((def.input_schema as { properties: Record<string, unknown> }).properties);
      for (const p of props) expect(p, `${def.name}.${p}`).not.toMatch(forbidden);
    }
  });
});

describe('ToolRunner validation', () => {
  it('rejects unknown tool names without touching the api', () => {
    const api = createFakeApi();
    const runner = new ToolRunner(api);
    for (const name of ['buy_item', 'confirm_purchase', 'sign_transaction', 'transfer_coins', 'run_code', 'constructor', '__proto__', 'toString', '', 'GET_PLAYER_CONTEXT']) {
      const o = runner.run(name, {});
      expect(o.ok, name).toBe(false);
      expect(o.content).toContain('Unknown tool');
      expect(o.actions).toEqual([]);
    }
    for (const bad of [null, undefined, 42, {}, ['navigate_to'], true]) expect(runner.run(bad, {}).ok).toBe(false);
    expect(api.calls).toHaveLength(0);
  });

  it('does not echo huge or hostile tool names back to the model', () => {
    const runner = new ToolRunner(createFakeApi());
    const o = runner.run('<script>alert(1)</script>' + 'x'.repeat(5000), {});
    expect(o.ok).toBe(false);
    expect(o.content.length).toBeLessThan(500);
    expect(o.content).not.toContain('<script>');
  });

  it('rejects extra keys: invented price, reward, confirm flags', () => {
    const api = createFakeApi();
    const runner = new ToolRunner(api);
    const cases: [string, unknown][] = [
      ['propose_purchase', { itemId: 'explorer_cap', price: 1 }],
      ['propose_purchase', { itemId: 'explorer_cap', confirm: true }],
      ['propose_purchase', { itemId: 'explorer_cap', autoBuy: true, amount: 3 }],
      ['navigate_to', { locationId: 'shop', teleport: true }],
      ['propose_mission', { ...validMission, rewardId: 'reward_treasure' }],
      ['propose_mission', { ...validMission, reward: { coins: 9999 } }],
      ['propose_mission', { ...validMission, coins: 9999 }],
      ['get_player_context', { playerId: 'someone-else' }],
      ['open_shop', { force: true }],
      ['find_players', { includeEmail: true }],
    ];
    for (const [name, input] of cases) {
      const o = runner.run(name, input);
      expect(o.ok, `${name} ${JSON.stringify(input)}`).toBe(false);
      expect(o.content).toMatch(/Invalid arguments/);
    }
    expect(api.calls).toHaveLength(0);
  });

  it('rejects missing, mistyped and oversized arguments', () => {
    const api = createFakeApi();
    const runner = new ToolRunner(api);
    expect(runner.run('navigate_to', {}).ok).toBe(false);
    expect(runner.run('navigate_to', { locationId: 12 }).ok).toBe(false);
    expect(runner.run('navigate_to', { locationId: 'x'.repeat(5000) }).ok).toBe(false);
    expect(runner.run('navigate_to', { locationId: 'shop; DROP TABLE' }).ok).toBe(false);
    expect(runner.run('propose_purchase', { itemId: '../../etc/passwd' }).ok).toBe(false);
    expect(runner.run('find_location', { query: 'y'.repeat(100_000) }).ok).toBe(false);
    expect(runner.run('find_location', { query: '   ' }).ok).toBe(false);
    expect(runner.run('propose_mission', { ...validMission, description: 'z'.repeat(10_000) }).ok).toBe(false);
    expect(runner.run('propose_mission', { ...validMission, title: 'ab' }).ok).toBe(false);
    expect(runner.run('propose_mission', { ...validMission, title: 't'.repeat(61) }).ok).toBe(false);
    expect(runner.run('propose_mission', { ...validMission, type: 'raid_boss' }).ok).toBe(false);
    expect(runner.run('propose_mission', { ...validMission, objectiveLocationIds: [] }).ok).toBe(false);
    expect(runner.run('propose_mission', { ...validMission, objectiveLocationIds: Array(7).fill('cafe') }).ok).toBe(false);
    expect(runner.run('propose_mission', { ...validMission, estimatedMinutes: 9999 }).ok).toBe(false);
    expect(runner.run('propose_mission', { ...validMission, estimatedMinutes: Number.NaN }).ok).toBe(false);
    expect(runner.run('propose_mission', 'not an object').ok).toBe(false);
    expect(api.calls).toHaveLength(0);
  });

  it('unknown or hidden location ids and unknown items never reach the game api', () => {
    const api = createFakeApi();
    const runner = new ToolRunner(api);
    const a = runner.run('navigate_to', { locationId: 'atlantis' });
    expect(a.ok).toBe(false);
    expect(a.content).toContain('Unknown location');
    for (const id of TREASURE_SPOT_IDS) expect(runner.run('navigate_to', { locationId: id }).ok, id).toBe(false);
    expect(api.callsTo('navigateTo')).toHaveLength(0);
    const p = runner.run('propose_purchase', { itemId: 'explorer_badge' }); // reward-only item
    expect(p.ok).toBe(false);
    expect(runner.run('propose_purchase', { itemId: 'free_money' }).ok).toBe(false);
    expect(api.callsTo('proposePurchase')).toHaveLength(0);
    expect(runner.actions).toEqual([]);
  });

  it('find_location hides locations the api did not list as public', () => {
    const api = createFakeApi();
    api.findLocation = () => ({ id: 'ts_oak', name: 'Old Oak Clearing', description: '', x: 0, z: 0, distance: 3 });
    const o = new ToolRunner(api).run('find_location', { query: 'oak' });
    expect(o.data).toMatchObject({ tool: 'find_location', found: false });
  });

  it('propose_mission forwards only whitelisted fields and cleans markup', () => {
    const api = createFakeApi();
    const runner = new ToolRunner(api);
    const o = runner.run('propose_mission', {
      title: '<b>Bread</b> **run** http://evil.example',
      description: 'Carry `fresh` bread <img src=x onerror=alert(1)> from the bakery to the cafe.',
      type: 'delivery',
      startLocationId: 'bakery',
      objectiveLocationIds: ['cafe'],
      estimatedMinutes: 3,
    });
    expect(o.ok).toBe(true);
    const sent = api.proposals[0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['description', 'estimatedMinutes', 'objectiveLocationIds', 'startLocationId', 'title', 'type']);
    expect(sent.title).toBe('Bread run');
    expect(String(sent.description)).not.toMatch(/[<>`]|onerror=alert/);
    expect(o.actions[0]).toMatchObject({ type: 'mission_offer' });
  });

  it('allows one mission offer, one navigation and distinct purchase proposals per request', () => {
    const runner = new ToolRunner(createFakeApi());
    expect(runner.run('propose_mission', validMission).ok).toBe(true);
    expect(runner.run('propose_mission', { ...validMission, title: 'Second run' }).ok).toBe(false);
    expect(runner.run('navigate_to', { locationId: 'shop' }).ok).toBe(true);
    expect(runner.run('navigate_to', { locationId: 'bakery' }).ok).toBe(false);
    expect(runner.run('propose_purchase', { itemId: 'coffee' }).ok).toBe(true);
    expect(runner.run('propose_purchase', { itemId: 'coffee' }).ok).toBe(false);
    expect(runner.run('propose_purchase', { itemId: 'explorer_cap' }).ok).toBe(true);
    expect(runner.run('propose_purchase', { itemId: 'round_shades' }).ok).toBe(true);
    expect(runner.run('propose_purchase', { itemId: 'neon_sneakers' }).ok).toBe(false);
  });

  it('surfaces api rejections as tool errors and never throws', () => {
    const api = createFakeApi({ cooldownTypes: ['delivery'] });
    const runner = new ToolRunner(api);
    const o = runner.run('propose_mission', validMission);
    expect(o.ok).toBe(false);
    expect(o.content).toContain('cooldown');
    api.getPlayerContext = () => {
      throw new Error('db exploded with secret=hunter2');
    };
    const e = runner.run('get_player_context', {});
    expect(e.ok).toBe(false);
    expect(e.content).not.toContain('hunter2');
  });

  it('turns trusted data into actions and facts', () => {
    const runner = new ToolRunner(createFakeApi({ coins: 90 }));
    runner.run('get_player_context', {});
    const items = runner.run('list_shop_items', {});
    expect(items.actions).toEqual([{ type: 'show_items', items: shopItems().map(toShopItemView) }]);
    expect(items.content).toContain('"price":40');
    const m = runner.run('propose_mission', validMission);
    expect(m.content).toContain('40 coins');
    expect(runner.facts.balance).toBe(90);
    expect(runner.facts.items.get('explorer_cap')).toEqual({ name: 'Explorer Cap', price: 40 });
    expect(runner.facts.rewardCoins.has(40)).toBe(true);
    expect(derivePlan(runner.outcomes).length).toBeGreaterThan(1);
  });

  it('never gives the model player emails or other private fields', () => {
    const api = createFakeApi({ players: [{ name: 'Ana#1234', distance: 3 }] });
    const runner = new ToolRunner(api);
    const all = TOOL_NAMES.map((n) => {
      const args = n === 'find_location' ? { query: 'shop' } : n === 'navigate_to' ? { locationId: 'shop' } : n === 'propose_purchase' ? { itemId: 'coffee' } : n === 'propose_mission' ? validMission : {};
      return runner.run(n, args).content;
    }).join('\n');
    expect(all).not.toMatch(/@|email|password|token/i);
  });
});
