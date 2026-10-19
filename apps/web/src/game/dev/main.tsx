import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { SPAWN, findPath, locationById } from '@pixels/shared';
import { runtime, useGame } from '../../state';
import type { Anim, MissionStateView } from '../../types';
import GameCanvas from '../GameCanvas';
import { camState, envCtl } from '../env';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

// ---- fake session
const selfId = 'dev-self';
useGame.setState({
  selfId,
  quality: (q.get('quality') as 'low' | 'high') || 'high',
  players: { [selfId]: { id: selfId, name: 'Tester#0001', equipped: {} } },
  account: {
    id: selfId, username: 'Tester', tag: '0001', displayName: 'Tester#0001', email: 't@example.com', coins: 100, inventory: {},
    equipped: q.get('outfit') === '1' ? { hat: 'explorer_cap', face: 'round_shades', shoes: 'neon_sneakers', jacket: 'sunset_hoodie' } : {},
  },
});
if (q.has('x')) Object.assign(runtime.local, { x: num('x', SPAWN.x), z: num('z', SPAWN.z), ry: num('ry', SPAWN.ry) });
else Object.assign(runtime.local, { x: SPAWN.x, z: SPAWN.z, ry: SPAWN.ry });
if (q.has('t')) envCtl.forceT = num('t', 0.5);
if (q.has('yaw')) camState.yaw = num('yaw', 0);
if (q.has('pitch')) camState.pitch = num('pitch', 0.42);
if (q.has('dist')) camState.dist = num('dist', 7.5);

const mission = (kind: 'goto' | 'pickup' | 'dropoff' | 'collect', id: string, x: number, z: number): MissionStateView => ({
  id: 'm1', type: 'delivery', title: 'Dev mission', description: 'x', reward: { label: '15 coins', mock: true },
  objectives: [{ id, kind, label: id, x, z, done: false }], current: 0, startedAt: 0, expiresAt: Date.now() + 1e6,
});
const missionKind = q.get('mission');
if (missionKind === 'pickup') useGame.setState({ mission: mission('pickup', 'bakery', -30, -8) });
if (missionKind === 'collect') useGame.setState({ mission: { ...mission('collect', 'ts_path', 0, -34), type: 'treasure_hunt' } });
if (missionKind === 'dropoff') useGame.setState({ mission: mission('dropoff', 'cafe', -42, 8) });

// ---- fake remote players walking in circles around the fountain / along the street
const remotes: { id: string; name: string; cx: number; cz: number; r: number; w: number; a: number; anim: Anim; eq: Record<string, string> }[] = [
  { id: 'r1', name: 'Alice#1234', cx: 1.5, cz: 28, r: 8, w: 0.4, a: 0, anim: 'walk', eq: { hat: 'explorer_cap' } },
  { id: 'r2', name: 'Bob#2201', cx: 20, cz: 7, r: 12, w: -0.5, a: 1, anim: 'run', eq: { face: 'round_shades', jacket: 'sunset_hoodie' } },
  { id: 'r3', name: 'Carol#9000', cx: -10, cz: 20, r: 0, w: 0, a: 0, anim: 'dance', eq: { shoes: 'neon_sneakers' } },
  { id: 'r4', name: 'Dave#0042', cx: 6, cz: 17, r: 0, w: 0, a: 2, anim: 'wave', eq: {} },
  { id: 'r5', name: 'Eve_longer_name#7777', cx: 4, cz: 12, r: 0, w: 0, a: 3, anim: 'cheer', eq: { hat: 'explorer_cap', shoes: 'neon_sneakers' } },
];
const nRemotes = q.has('remotes') ? num('remotes', 5) : 5;
const t0 = performance.now() / 1000;
function tick() {
  const now = performance.now() / 1000;
  const el = now - t0;
  for (const r of remotes.slice(0, nRemotes)) {
    const ang = r.a + r.w * el;
    const x = r.cx + Math.cos(ang) * r.r;
    const z = r.cz + Math.sin(ang) * r.r;
    const ry = r.r ? Math.atan2(-Math.sin(ang) * r.w * r.r, Math.cos(ang) * r.w * r.r) : r.a;
    let rem = runtime.remotes.get(r.id);
    if (!rem) {
      rem = { id: r.id, name: r.name, equipped: r.eq, buffer: [], x, z, ry, anim: r.anim };
      runtime.remotes.set(r.id, rem);
    }
    rem.buffer.push({ t: now, x, z, ry, anim: r.anim === 'walk' || r.anim === 'run' ? r.anim : r.anim });
    if (rem.buffer.length > 30) rem.buffer.shift();
    if (r.id === 'r1' && Math.floor(el) % 12 === 3) rem.chatBubble = { text: 'Hello from the plaza! Nice weather today, isn\'t it?', until: now + 5 };
  }
}
setInterval(tick, 100);
tick();

// ---- helpers for the screenshot / input scripts
(window as unknown as { __dev: unknown }).__dev = {
  setTime: (t: number | null) => { envCtl.forceT = t; },
  setCam: (yaw: number, pitch: number, dist: number) => { camState.yaw = yaw; camState.pitch = pitch; camState.dist = dist; },
  teleport: (x: number, z: number, ry?: number) => { if (ry !== undefined) runtime.local.ry = ry; runtime.correction = { x, z }; },
  setMission: (m: MissionStateView | null) => useGame.setState({ mission: m }),
  nav: (id: string) => {
    const loc = locationById(id)!;
    const pts = findPath({ x: runtime.local.x, z: runtime.local.z }, { x: loc.x, z: loc.z });
    if (pts) runtime.navPath = { points: pts, label: loc.name, locationId: id };
    return pts;
  },
  state: () => useGame.getState(),
  set: (p: Parameters<typeof useGame.setState>[0]) => useGame.setState(p),
  say: (text: string) => useGame.setState({ chat: [...useGame.getState().chat, { id: String(Math.random()), playerId: selfId, name: 'Tester', text, time: Date.now() + runtime.serverOffsetMs }] }),
  runtime,
};

function Hud() {
  const prompt = useGame((s) => s.nearPrompt);
  const toasts = useGame((s) => s.toasts);
  useEffect(() => {
    document.title = 'Pixels 3D dev harness';
  }, []);
  return (
    <div id="hud">
      {prompt ?? 'WASD move · Shift run · drag to orbit · wheel zoom · 1/2/3 emotes · E interact'}
      {toasts.map((t) => (
        <div key={t.id}>{t.text}</div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <div style={{ position: 'fixed', inset: 0 }}>
    <GameCanvas />
    <Hud />
  </div>,
);
