import type { Anim } from '../../types';

/**
 * Joint targets for the procedural humanoid. Pure functions, no three.js.
 * Sides are relative to the character: L = character's left (+x, the character faces +z), R = right (-x).
 * swing: forward positive, abd: away from the body positive, knee/elbow: flexion positive.
 */
export interface JointPose {
  hipsY: number;
  hipsRoll: number;
  hipsYaw: number;
  spineX: number;
  spineY: number;
  spineZ: number;
  headX: number;
  headY: number;
  headZ: number;
  breathe: number;
  armLSwing: number; armLAbd: number; armLElbow: number; armLElbowZ: number;
  armRSwing: number; armRAbd: number; armRElbow: number; armRElbowZ: number;
  legLSwing: number; legLAbd: number; legLKnee: number;
  legRSwing: number; legRAbd: number; legRKnee: number;
}

export const POSE_KEYS = [
  'hipsY', 'hipsRoll', 'hipsYaw', 'spineX', 'spineY', 'spineZ', 'headX', 'headY', 'headZ', 'breathe',
  'armLSwing', 'armLAbd', 'armLElbow', 'armLElbowZ', 'armRSwing', 'armRAbd', 'armRElbow', 'armRElbowZ',
  'legLSwing', 'legLAbd', 'legLKnee', 'legRSwing', 'legRAbd', 'legRKnee',
] as const satisfies readonly (keyof JointPose)[];

export const makePose = (): JointPose => {
  const p = {} as JointPose;
  for (const k of POSE_KEYS) p[k] = 0;
  return p;
};

const LEG_LEN = 0.9;

export interface Gait {
  /** hip swing amplitude (rad) */
  amp: number;
  /** phase rate (rad/s) */
  omega: number;
}
/** Stride amplitude and cadence so that planted feet roughly match the ground speed. */
export function gaitFor(speed: number, out: Gait = { amp: 0, omega: 0 }): Gait {
  const v = Math.max(0, speed);
  const amp = Math.min(0.92, Math.max(0.22, 0.26 + 0.1 * v));
  out.amp = amp;
  out.omega = v < 0.05 ? 0 : (Math.PI * v) / (2 * LEG_LEN * amp);
  return out;
}

/** Fill `out` with the target pose for `anim` at animation time `time` (s), gait `phase` (rad) and ground `speed` (m/s). */
export function targetPose(anim: Anim, time: number, phase: number, speed: number, out: JointPose): JointPose {
  for (const k of POSE_KEYS) out[k] = 0;
  const br = Math.sin(time * 1.7);
  switch (anim) {
    case 'walk':
    case 'run': {
      const run = anim === 'run';
      const A = gaitFor(speed).amp;
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      out.legLSwing = A * s;
      out.legRSwing = -A * s;
      const K = run ? 1.55 : 0.95;
      out.legLKnee = K * Math.max(0, c) + (run ? 0.15 : 0.05);
      out.legRKnee = K * Math.max(0, -c) + (run ? 0.15 : 0.05);
      const armA = run ? 0.95 : 0.55;
      out.armLSwing = -armA * s;
      out.armRSwing = armA * s;
      const elbow = run ? 1.35 : 0.3;
      out.armLElbow = elbow + (run ? 0.2 : 0.25) * Math.max(0, -s);
      out.armRElbow = elbow + (run ? 0.2 : 0.25) * Math.max(0, s);
      out.armLAbd = 0.08;
      out.armRAbd = 0.08;
      out.hipsY = LEG_LEN * (Math.cos(A * Math.abs(s)) - 1) + (run ? 0.03 * Math.abs(c) : 0.01 * Math.abs(c));
      out.spineX = run ? 0.24 : 0.06;
      out.spineY = -(run ? 0.22 : 0.12) * s;
      out.hipsYaw = (run ? 0.18 : 0.1) * s;
      out.hipsRoll = 0.025 * c;
      out.headX = -out.spineX * 0.6;
      out.headY = 0.1 * s;
      break;
    }
    case 'wave': {
      const w = Math.sin(time * 9.5);
      out.armRAbd = 2.55;
      out.armRSwing = 0.15;
      out.armRElbow = 0.25;
      out.armRElbowZ = -0.55 * w;
      out.armLAbd = 0.1;
      out.armLSwing = 0.05 * br;
      out.armLElbow = 0.2;
      out.headZ = -0.1;
      out.headY = -0.18 + 0.05 * Math.sin(time * 2.1);
      out.spineY = 0.06;
      out.hipsRoll = 0.02 * Math.sin(time * 1.4);
      out.spineX = 0.01 * br;
      out.legLKnee = 0.03;
      out.legRKnee = 0.03;
      out.breathe = 0.5 + 0.5 * br;
      break;
    }
    case 'dance': {
      const b = time * 11.3;
      const sw = Math.sin(b * 0.5);
      const cw = Math.cos(b * 0.5);
      out.hipsY = -0.06 + 0.05 * Math.sin(b + 1.2);
      out.hipsRoll = 0.14 * sw;
      out.hipsYaw = 0.3 * sw;
      out.spineY = -0.34 * sw;
      out.spineZ = -0.08 * sw;
      out.spineX = 0.05;
      out.armLAbd = 1.35 + 0.75 * sw;
      out.armRAbd = 1.35 - 0.75 * sw;
      out.armLSwing = 0.45 * cw;
      out.armRSwing = -0.45 * cw;
      out.armLElbow = 0.7 + 0.45 * Math.sin(b);
      out.armRElbow = 0.7 + 0.45 * Math.sin(b + Math.PI);
      out.legLSwing = 0.28 * sw;
      out.legRSwing = -0.28 * sw;
      out.legLAbd = 0.08 + 0.1 * Math.max(0, sw);
      out.legRAbd = 0.08 + 0.1 * Math.max(0, -sw);
      out.legLKnee = 0.55 + 0.4 * Math.max(0, sw) + 0.1 * Math.sin(b);
      out.legRKnee = 0.55 + 0.4 * Math.max(0, -sw) + 0.1 * Math.sin(b);
      out.headX = 0.12 * Math.sin(b);
      out.headZ = 0.12 * sw;
      out.breathe = 0.5 + 0.5 * Math.sin(b);
      break;
    }
    case 'cheer': {
      const j = Math.max(0, Math.sin(time * 6.4));
      out.hipsY = 0.24 * j - 0.08 * (1 - j);
      out.armLAbd = 2.7 + 0.18 * Math.sin(time * 13);
      out.armRAbd = 2.7 - 0.18 * Math.sin(time * 13);
      out.armLSwing = 0.15;
      out.armRSwing = 0.15;
      out.armLElbow = 0.15 + 0.3 * (1 - j);
      out.armRElbow = 0.15 + 0.3 * (1 - j);
      out.legLKnee = 0.5 * (1 - j) + 0.1;
      out.legRKnee = 0.5 * (1 - j) + 0.1;
      out.legLAbd = 0.12;
      out.legRAbd = 0.12;
      out.legLSwing = -0.1 * j;
      out.legRSwing = 0.1 * j;
      out.headX = -0.22;
      out.spineX = -0.05;
      out.breathe = 1;
      break;
    }
    default: {
      // idle: breathing + subtle weight shift
      out.breathe = 0.5 + 0.5 * br;
      out.spineX = 0.012 * br;
      out.hipsRoll = 0.018 * Math.sin(time * 0.6);
      out.hipsYaw = 0.025 * Math.sin(time * 0.5);
      out.hipsY = -0.004 * br;
      out.armLAbd = 0.1 + 0.015 * br;
      out.armRAbd = 0.1 + 0.015 * br;
      out.armLSwing = 0.04 * Math.sin(time * 1.1);
      out.armRSwing = -0.04 * Math.sin(time * 1.1);
      out.armLElbow = 0.14;
      out.armRElbow = 0.14;
      out.legLKnee = 0.03;
      out.legRKnee = 0.03;
      out.headY = 0.2 * Math.sin(time * 0.43) * Math.sin(time * 0.17);
      out.headX = 0.03 * Math.sin(time * 0.9);
      break;
    }
  }
  return out;
}
