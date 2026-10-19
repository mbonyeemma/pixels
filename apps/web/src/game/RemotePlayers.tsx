import { memo, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { runtime, useGame } from '../state';
import type { Equipped } from '../types';
import { Avatar, makeDriver, type AvatarDriver } from './Avatar';
import { effectiveAnim, pruneSnapshots, sampleSnapshots, type SampledPose } from './logic/interp';

interface Entry {
  id: string;
  name: string;
  equipped: Equipped;
  sig: string;
}

const sigOf = (r: { name: string; equipped: Equipped }): string => `${r.name}|${r.equipped.hat ?? ''}|${r.equipped.face ?? ''}|${r.equipped.shoes ?? ''}|${r.equipped.jacket ?? ''}`;

const RemotePlayer = memo(function RemotePlayer({ id, name, equipped }: { id: string; name: string; equipped: Equipped }) {
  const driver = useMemo<AvatarDriver>(() => makeDriver(), []);
  const sampled = useMemo<SampledPose>(() => ({ x: 0, z: 0, ry: 0, anim: 'idle', speed: 0 }), []);
  const initialised = useRef(false);
  const ry = useRef(0);
  const getBubble = useMemo(
    () => () => {
      const r = runtime.remotes.get(id);
      const b = r?.chatBubble;
      if (!b) return null;
      return b.until > performance.now() / 1000 ? b.text : null;
    },
    [id],
  );

  useFrame((_, delta) => {
    const r = runtime.remotes.get(id);
    if (!r) return;
    const now = performance.now() / 1000;
    pruneSnapshots(r.buffer, now);
    if (!sampleSnapshots(r.buffer, now, sampled)) return;
    const a = effectiveAnim(sampled.anim, sampled.speed);
    // smooth the heading a little to hide 10 Hz snapshot steps
    if (!initialised.current) {
      ry.current = sampled.ry;
      initialised.current = true;
    } else {
      let d = (sampled.ry - ry.current) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      ry.current += d * (1 - Math.exp(-Math.min(delta, 0.1) * 16));
    }
    driver.x = sampled.x;
    driver.z = sampled.z;
    driver.ry = ry.current;
    driver.anim = a;
    driver.speed = sampled.speed;
    r.x = sampled.x;
    r.z = sampled.z;
    r.ry = ry.current;
    r.anim = a;
  }, -2);

  return <Avatar id={id} name={name} equipped={equipped} driver={driver} getBubble={getBubble} />;
});

/** Mounts one avatar per remote player. The id set / appearance is polled at ~4 Hz; React state changes only on change. */
export default function RemotePlayers() {
  const [list, setList] = useState<Entry[]>([]);
  const acc = useRef(0);
  const last = useRef('');

  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < 0.25 && last.current !== '') return;
    acc.current = 0;
    const self = useGame.getState().selfId;
    const entries: Entry[] = [];
    let key = '';
    for (const r of runtime.remotes.values()) {
      if (r.id === self) continue;
      const sig = sigOf(r);
      entries.push({ id: r.id, name: r.name, equipped: r.equipped, sig });
      key += r.id + ':' + sig + ';';
    }
    if (key !== last.current) {
      last.current = key || ' ';
      entries.sort((a, b) => (a.id < b.id ? -1 : 1));
      setList(entries);
    }
  });

  return (
    <>
      {list.map((e) => (
        <RemotePlayer key={e.id} id={e.id} name={e.name} equipped={e.equipped} />
      ))}
    </>
  );
}
