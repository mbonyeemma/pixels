import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { COLLIDERS, MOVE_SEND_HZ, PLAYER_RADIUS, RUN_SPEED, SPAWN, WALK_SPEED, resolveCollisions } from '@pixels/shared';
import { runtime, useGame } from '../state';
import type { Anim, Equipped } from '../types';
import { Avatar } from './Avatar';
import { gameClient } from './client';
import { camState, localDriver, localInfo, nav, pick } from './env';
import { angleDiff } from './logic/interp';
import { pickInteractable } from './logic/interact';
import { createFollower, makeSteerOut, steerAlongPath } from './logic/steer';

const EMPTY: Equipped = {};

/** Mutable controller state (module level: one local player per page). */
const ctl = {
  x: SPAWN.x as number,
  z: SPAWN.z as number,
  ry: SPAWN.ry as number,
  vx: 0,
  vz: 0,
  speed: 0,
  anim: 'idle' as Anim,
  emote: null as Anim | null,
  emoteT: 0,
  emoteResend: 0,
  keys: new Set<string>(),
  shift: false,
  lastSend: 0,
  lastKeepalive: 0,
  wasMoving: false,
  corr: null as null | { x: number; z: number },
  pickT: 0,
  initFor: null as string | null,
  promptShown: null as string | null,
};

const KEYMAP: Record<string, 'f' | 'b' | 'l' | 'r'> = {
  KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
};
const EMOTE_KEYS: Record<string, Anim> = { Digit1: 'wave', Digit2: 'dance', Digit3: 'cheer', Numpad1: 'wave', Numpad2: 'dance', Numpad3: 'cheer' };

const isTextTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
};
/** Game keys are ignored while typing or while a MODAL panel is open. The AI guide / inventory panels are docked and non-modal. */
const isModal = (panel: string): boolean => panel === 'shop' || panel === 'help';
const uiBlocked = (): boolean => {
  const s = useGame.getState();
  return s.typing || isModal(s.panel);
};

function readRuntimePose(): void {
  const l = runtime.local;
  if (l.x === 0 && l.z === 0 && l.ry === 0) {
    ctl.x = SPAWN.x;
    ctl.z = SPAWN.z;
    ctl.ry = SPAWN.ry;
  } else {
    ctl.x = l.x;
    ctl.z = l.z;
    ctl.ry = l.ry;
  }
  ctl.vx = ctl.vz = ctl.speed = 0;
  ctl.anim = 'idle';
  ctl.emote = null;
  ctl.corr = null;
  ctl.wasMoving = false;
  localDriver.x = ctl.x;
  localDriver.z = ctl.z;
  localDriver.ry = ctl.ry;
  localDriver.anim = 'idle';
  localDriver.speed = 0;
  camState.ready = false;
  camState.dist = 7.5;
  camState.pitch = 0.42;
  camState.effDist = 7.5;
}

function cancelEmote(notifyServer: boolean): void {
  if (!ctl.emote) return;
  ctl.emote = null;
  ctl.anim = 'idle';
  if (notifyServer) gameClient.sendEmote('idle');
}

function startOrToggleEmote(a: Anim): void {
  if (a === 'idle') {
    cancelEmote(true);
    return;
  }
  if (ctl.emote === a) {
    cancelEmote(true);
    return;
  }
  ctl.emote = a;
  ctl.emoteT = 0;
  ctl.emoteResend = 0;
  ctl.anim = a;
  gameClient.sendEmote(a);
}

function doInteract(): void {
  const p = pick.current;
  if (!p) return;
  if (p.action.kind === 'shop') useGame.getState().setPanel('shop');
  else gameClient.interact(p.action.target);
}

export default function LocalPlayer() {
  const selfId = useGame((s) => s.selfId);
  const selfName = useGame((s) => (s.selfId ? s.players[s.selfId]?.name : undefined) ?? s.account?.displayName ?? 'You');
  const accEq = useGame((s) => s.account?.equipped);
  const plEq = useGame((s) => (s.selfId ? s.players[s.selfId]?.equipped : undefined));
  const equipped = accEq ?? plEq ?? EMPTY;

  // initial pose from the net layer
  useEffect(() => {
    if (selfId && ctl.initFor !== selfId) {
      ctl.initFor = selfId;
      readRuntimePose();
    }
    if (!selfId) ctl.initFor = null;
    localInfo.visible = !!selfId;
  }, [selfId]);

  // input
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTextTarget(e.target) || uiBlocked()) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const dir = KEYMAP[e.code];
      if (dir) {
        ctl.keys.add(dir);
        if (e.code.startsWith('Arrow')) e.preventDefault();
        return;
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        ctl.shift = true;
        return;
      }
      if (e.repeat) return;
      if (e.code === 'KeyE') {
        doInteract();
        return;
      }
      const emote = EMOTE_KEYS[e.code];
      if (emote) startOrToggleEmote(emote);
    };
    const up = (e: KeyboardEvent) => {
      const dir = KEYMAP[e.code];
      if (dir) ctl.keys.delete(dir);
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') ctl.shift = false;
    };
    const clear = () => {
      ctl.keys.clear();
      ctl.shift = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
      clear();
    };
  }, []);

  const steerOut = useMemo(() => makeSteerOut(), []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const gs = useGame.getState();
    if (!gs.selfId) {
      pick.current = null;
      if (gs.nearPrompt) useGame.setState({ nearPrompt: null });
      return;
    }
    if (ctl.initFor !== gs.selfId) {
      ctl.initFor = gs.selfId;
      readRuntimePose();
    }
    const now = performance.now() / 1000;
    const blocked = gs.typing || isModal(gs.panel);
    if (blocked && (ctl.keys.size || ctl.shift)) {
      ctl.keys.clear();
      ctl.shift = false;
    }

    // ---- server corrections (rubber band)
    if (runtime.correction) {
      const c = runtime.correction;
      runtime.correction = null;
      if (Math.hypot(c.x - ctl.x, c.z - ctl.z) > 4) {
        ctl.x = c.x;
        ctl.z = c.z;
        ctl.vx = ctl.vz = 0;
        camState.ready = false;
      } else ctl.corr = { x: c.x, z: c.z };
    }

    // ---- emote requests from the UI
    if (runtime.emoteRequest) {
      const r = runtime.emoteRequest;
      runtime.emoteRequest = null;
      startOrToggleEmote(r);
    }

    // ---- desired movement
    let dirX = 0;
    let dirZ = 0;
    let wantRun = false;
    let manual = false;
    if (ctl.keys.size) {
      const f = (ctl.keys.has('f') ? 1 : 0) - (ctl.keys.has('b') ? 1 : 0);
      const r = (ctl.keys.has('r') ? 1 : 0) - (ctl.keys.has('l') ? 1 : 0);
      if (f || r) {
        const yaw = camState.yaw;
        // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
        dirX = -Math.sin(yaw) * f + Math.cos(yaw) * r;
        dirZ = -Math.cos(yaw) * f - Math.sin(yaw) * r;
        const l = Math.hypot(dirX, dirZ);
        dirX /= l;
        dirZ /= l;
        wantRun = ctl.shift;
        manual = true;
      }
    }
    // ---- auto-walk
    const np = runtime.navPath;
    if (np !== nav.path) {
      nav.path = np;
      nav.follower = createFollower();
    }
    if (np) {
      if (manual) {
        runtime.navPath = null;
        nav.path = null;
      } else {
        steerAlongPath(nav.follower, ctl.x, ctl.z, np.points, dt, steerOut);
        if (steerOut.status === 'arrived') {
          useGame.getState().toast(`You arrived at ${np.label}`);
          runtime.navPath = null;
          nav.path = null;
        } else if (steerOut.status === 'blocked') {
          useGame.getState().toast('Auto-walk stopped: the way is blocked', 'warn');
          runtime.navPath = null;
          nav.path = null;
        } else {
          dirX = steerOut.dirX;
          dirZ = steerOut.dirZ;
          wantRun = steerOut.run;
          manual = true; // movement from auto-walk also cancels emotes
        }
      }
    }
    const moveIntent = manual && (dirX !== 0 || dirZ !== 0);
    if (moveIntent && ctl.emote) cancelEmote(false);

    // ---- integrate (sub-stepped so slow frames never tunnel through thin colliders)
    const targetSpeed = moveIntent ? (wantRun ? RUN_SPEED : WALK_SPEED) : 0;
    const tvx = dirX * targetSpeed;
    const tvz = dirZ * targetSpeed;
    const steps = Math.max(1, Math.ceil(dt / 0.04));
    const h = dt / steps;
    for (let si = 0; si < steps; si++) {
      const k = 1 - Math.exp(-h * (targetSpeed > 0 ? 11 : 9));
      ctl.vx += (tvx - ctl.vx) * k;
      ctl.vz += (tvz - ctl.vz) * k;
      if (targetSpeed === 0 && Math.hypot(ctl.vx, ctl.vz) < 0.05) ctl.vx = ctl.vz = 0;
      const ox = ctl.x;
      const oz = ctl.z;
      let nx = ox + ctl.vx * h;
      let nz = oz + ctl.vz * h;
      if (ctl.corr) {
        const ck = 1 - Math.exp(-h * 12);
        nx += (ctl.corr.x - nx) * ck;
        nz += (ctl.corr.z - nz) * ck;
        if (Math.hypot(ctl.corr.x - nx, ctl.corr.z - nz) < 0.03) ctl.corr = null;
      }
      const res = resolveCollisions(nx, nz, PLAYER_RADIUS, COLLIDERS);
      ctl.x = res[0];
      ctl.z = res[1];
      const ax = (ctl.x - ox) / h;
      const az = (ctl.z - oz) / h;
      // sliding: keep the component of velocity that survived collision resolution
      if (Math.hypot(ax, az) + 0.01 < Math.hypot(ctl.vx, ctl.vz)) {
        ctl.vx = ax;
        ctl.vz = az;
      }
    }
    const spd = Math.hypot(ctl.vx, ctl.vz);
    ctl.speed += (spd - ctl.speed) * Math.min(1, dt * 14);

    // facing
    if (moveIntent) {
      const target = Math.atan2(dirX, dirZ);
      ctl.ry += angleDiff(ctl.ry, target) * (1 - Math.exp(-dt * 13));
    }
    // anim
    if (ctl.emote) {
      ctl.anim = ctl.emote;
      ctl.emoteT += dt;
      if ((ctl.emote === 'wave' && ctl.emoteT > 3.0) || (ctl.emote === 'cheer' && ctl.emoteT > 3.2)) cancelEmote(false);
      else if (ctl.emote === 'dance') {
        ctl.emoteResend += dt;
        if (ctl.emoteResend > 2.4) {
          ctl.emoteResend = 0;
          gameClient.sendEmote('dance'); // the server holds emotes ~3 s: renew while dancing
        }
      }
    } else {
      const a = ctl.anim;
      if (a === 'run') ctl.anim = ctl.speed < 4.0 ? (ctl.speed < 0.25 ? 'idle' : 'walk') : 'run';
      else if (a === 'walk') ctl.anim = ctl.speed > 4.7 ? 'run' : ctl.speed < 0.25 ? 'idle' : 'walk';
      else ctl.anim = ctl.speed > 0.5 ? (ctl.speed > 4.7 ? 'run' : 'walk') : 'idle';
    }

    // ---- publish pose
    const l = runtime.local;
    l.x = ctl.x;
    l.z = ctl.z;
    l.ry = ctl.ry;
    l.anim = ctl.anim;
    l.speed = ctl.speed;
    localDriver.x = ctl.x;
    localDriver.z = ctl.z;
    localDriver.ry = ctl.ry;
    localDriver.anim = ctl.anim;
    localDriver.speed = ctl.speed;

    // ---- network: ~15 Hz while moving, one final idle, 1 Hz keepalive
    const moving = ctl.speed > 0.08 || moveIntent;
    if (moving) {
      if (now - ctl.lastSend >= 1 / MOVE_SEND_HZ) {
        gameClient.sendMove(ctl.x, ctl.z, ctl.ry, ctl.anim, ++runtime.localMoveSeq);
        ctl.lastSend = now;
        ctl.lastKeepalive = now;
      }
      ctl.wasMoving = true;
    } else if (ctl.wasMoving) {
      ctl.wasMoving = false;
      gameClient.sendMove(ctl.x, ctl.z, ctl.ry, ctl.anim, ++runtime.localMoveSeq);
      ctl.lastSend = now;
      ctl.lastKeepalive = now;
    } else if (now - ctl.lastKeepalive >= 1) {
      gameClient.sendMove(ctl.x, ctl.z, ctl.ry, ctl.anim, ++runtime.localMoveSeq);
      ctl.lastKeepalive = now;
    }

    // ---- interaction prompt (throttled)
    ctl.pickT += dt;
    if (ctl.pickT >= 0.1) {
      ctl.pickT = 0;
      const p = pickInteractable(ctl.x, ctl.z, gs.mission);
      pick.current = p;
      const prompt = p && !isModal(gs.panel) ? p.prompt : null;
      if (prompt !== gs.nearPrompt) useGame.setState({ nearPrompt: prompt });
    }
  }, -3);

  if (!selfId) return null;
  return <Avatar id={selfId} name={selfName} equipped={equipped} driver={localDriver} getBubble={getLocalBubble} />;
}

function getLocalBubble(): string | null {
  const s = useGame.getState();
  const id = s.selfId;
  if (!id) return null;
  for (let i = s.chat.length - 1; i >= 0 && i > s.chat.length - 12; i--) {
    const c = s.chat[i];
    if (c.system || c.playerId !== id) continue;
    // chat line times are server time (ms)
    const age = Date.now() + runtime.serverOffsetMs - c.time;
    return age > -3000 && age < 6000 ? c.text : null;
  }
  return null;
}
