import type { ReactNode } from 'react';
import type { ShopItem } from '@pixels/shared';

/** Tiny flat illustrations for catalogue items (no external assets). */
export default function ItemArt({ item, size = 44 }: { item: Pick<ShopItem, 'id' | 'kind' | 'slot' | 'color'>; size?: number }) {
  const c = item.color ?? '#94a3b8';
  let art: ReactNode;
  if (item.slot === 'hat') {
    art = (
      <>
        <path d="M10 28c0-9 5-15 14-15s14 6 14 15z" fill={c} />
        <path d="M8 28h34c0 3-5 5-12 5H16c-5 0-8-2-8-5z" fill={c} opacity="0.75" />
        <circle cx="24" cy="13" r="2" fill="#fff" opacity="0.7" />
      </>
    );
  } else if (item.slot === 'face') {
    art = (
      <>
        <circle cx="15" cy="25" r="8" fill={c} />
        <circle cx="33" cy="25" r="8" fill={c} />
        <path d="M22 24c1.4-1.4 2.6-1.4 4 0" stroke={c} strokeWidth="2.5" fill="none" />
        <path d="M9 22l-4-3M39 22l4-3" stroke={c} strokeWidth="2.5" />
        <path d="M11 22l3-2" stroke="#fff" strokeWidth="1.6" opacity="0.5" />
      </>
    );
  } else if (item.slot === 'shoes') {
    art = (
      <>
        <path d="M6 31c0-6 3-9 7-9l7 6c5 1 9 2 14 5 3 1 5 2 5 4v2H6z" fill={c} />
        <path d="M6 36h33v3H6z" fill="#fff" opacity="0.85" />
        <path d="M14 24l3 3M18 26l3 3" stroke="#fff" strokeWidth="1.6" opacity="0.8" />
      </>
    );
  } else if (item.slot === 'jacket') {
    art = (
      <>
        <path d="M16 10l-9 6 3 10 5-2v16h18V24l5 2 3-10-9-6c-1 3-4 5-8 5s-7-2-8-5z" fill={c} />
        <path d="M24 17v24" stroke="#fff" strokeWidth="1.6" opacity="0.45" />
        <rect x="19" y="31" width="10" height="6" rx="2" fill="#000" opacity="0.15" />
      </>
    );
  } else if (item.kind === 'consumable') {
    art = (
      <>
        <path d="M12 18h20v14c0 4-3 7-7 7h-6c-4 0-7-3-7-7z" fill="#e2e8f0" />
        <path d="M32 21h3c3 0 5 2 5 5s-2 5-5 5h-3" stroke="#e2e8f0" strokeWidth="3" fill="none" />
        <rect x="12" y="18" width="20" height="5" fill="#92400e" />
        <path d="M17 13c-2-2 2-3 0-6M23 13c-2-2 2-3 0-6M29 13c-2-2 2-3 0-6" stroke="#cbd5e1" strokeWidth="1.6" fill="none" opacity="0.8" strokeLinecap="round" />
      </>
    );
  } else if (item.kind === 'collectible') {
    art = (
      <>
        <path d="M24 6l14 12-14 24L10 18z" fill="url(#gem)" />
        <path d="M10 18h28M24 6l-5 12 5 24 5-24z" stroke="#fff" strokeWidth="1.4" opacity="0.55" fill="none" />
      </>
    );
  } else {
    art = (
      <>
        <path d="M24 5l5.2 11 12 1.6-8.8 8.3 2.2 11.9L24 31.2 13.4 37.8l2.2-11.9L6.8 17.6l12-1.6z" fill="#fbbf24" />
        <path d="M24 10l3 7 7.5 1-5.4 5.1 1.3 7.4L24 27l-6.4 3.5 1.3-7.4L13.5 18l7.5-1z" fill="#fde68a" opacity="0.7" />
      </>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false" className="item-art">
      <defs>
        <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#67e8f9" />
          <stop offset="0.5" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#f0abfc" />
        </linearGradient>
      </defs>
      {art}
    </svg>
  );
}
