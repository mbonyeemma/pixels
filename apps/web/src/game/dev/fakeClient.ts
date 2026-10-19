import type { GameClientApi } from '../../state';
import type { Anim } from '../../types';

/** Fake network facade for the dev harness: records calls so tests/screenshots can inspect them. */
export interface FakeCalls {
  moves: { x: number; z: number; ry: number; anim: Anim; seq: number; t: number }[];
  emotes: Anim[];
  interacts: string[];
}
const calls: FakeCalls = { moves: [], emotes: [], interacts: [] };
(globalThis as unknown as { __fakeCalls: FakeCalls }).__fakeCalls = calls;

const noop = async () => {};
export const gameClient: GameClientApi = {
  login: noop,
  resume: async () => false,
  logout: () => {},
  sendMove: (x, z, ry, anim, seq) => {
    calls.moves.push({ x, z, ry, anim, seq, t: performance.now() });
    if (calls.moves.length > 5000) calls.moves.splice(0, 2500);
  },
  sendEmote: (a) => calls.emotes.push(a),
  sendChat: () => {},
  interact: (t) => calls.interacts.push(t),
  buy: () => {},
  equip: () => {},
  acceptMission: () => {},
  abandonMission: () => {},
  askAi: noop,
  navigateTo: () => {},
};
