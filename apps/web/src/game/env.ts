import { makeSkyState } from './logic/daynight';
import { makeDriver } from './Avatar';
import { createFollower, makeSteerOut } from './logic/steer';
import type { Interactable } from './logic/interact';

/** Shared mutable singletons for the 3D layer (not React state: written every frame). */

/** Current lighting state, recomputed every frame by <Environment/>. */
export const skyState = makeSkyState();
/** Development / test override of the time of day ([0,1) or null for the server clock). */
export const envCtl: { forceT: number | null } = { forceT: null };

/** Orbit camera state. yaw: camera azimuth (0 = camera on +z looking north), pitch: elevation above horizontal. */
export const camState = { yaw: 0, pitch: 0.42, dist: 7.5, effDist: 7.5, x: 0, y: 0, z: 0, ready: false };

/** The local avatar's driver (position/anim), read by <Avatar/> and the camera. */
export const localDriver = makeDriver();

/** Auto-walk follower state (waypoint index etc.). `path` identifies the runtime.navPath it belongs to. */
export const nav = { follower: createFollower(), path: null as unknown, steer: makeSteerOut() };

/** What the player could interact with right now (computed by the controller). */
export const pick: { current: Interactable | null } = { current: null };

export const localInfo = { visible: false };
