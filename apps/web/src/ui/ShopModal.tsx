import { useEffect, useMemo, useRef, useState } from 'react';
import { shopItems, type ShopItem } from '@pixels/shared';
import { useGame } from '../state';
import { gameClient } from '../net/client';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { closePanel } from './focus';
import { IconClose, IconCoin } from './icons';
import { KIND_LABEL, SLOT_LABEL } from './format';
import ItemArt from './ItemArt';

export default function ShopModal() {
  const open = useGame((s) => s.panel === 'shop');
  return open ? <ShopDialog /> : null;
}

function ShopDialog() {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);
  const account = useGame((s) => s.account);
  const [pending, setPending] = useState<string | null>(null);
  const items = useMemo(() => shopItems(), []);
  const coins = account?.coins ?? 0;
  const invKey = JSON.stringify(account?.inventory ?? {});

  // a server answer (coins or inventory changed) or a toast means the purchase is settled
  useEffect(() => setPending(null), [coins, invKey]);
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setPending(null), 4000);
    return () => clearTimeout(id);
  }, [pending]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && closePanel()}>
      <div ref={ref} className="dialog glass shop" role="dialog" aria-modal="true" aria-labelledby="shop-title" tabIndex={-1}>
        <header className="dialog-head">
          <div>
            <h2 id="shop-title">Pixel Market</h2>
            <p className="dialog-sub">Spend your coins on looks and keepsakes.</p>
          </div>
          <div className="dialog-head-right">
            <div className="coins coins--big" aria-label={`You have ${coins} coins`}>
              <IconCoin size={20} />
              <span className="coins-value">{coins.toLocaleString()}</span>
            </div>
            <button type="button" className="icon-btn" aria-label="Close shop" data-autofocus onClick={closePanel}>
              <IconClose />
            </button>
          </div>
        </header>

        <ul className="shop-grid">
          {items.map((item) => (
            <ShopCard key={item.id} item={item} coins={coins} pending={pending === item.id} onBuy={() => {
              setPending(item.id);
              gameClient.buy(item.id);
            }} />
          ))}
        </ul>

        <footer className="dialog-foot">
          Mock economy: coins and items are in-game only, have no real-world value, and nothing here is recorded on a blockchain.
        </footer>
      </div>
    </div>
  );
}

function ShopCard({ item, coins, pending, onBuy }: { item: ShopItem; coins: number; pending: boolean; onBuy: () => void }) {
  const account = useGame((s) => s.account);
  const price = item.price ?? 0;
  const owned = account?.inventory[item.id] ?? 0;
  const equipped = !!item.slot && account?.equipped[item.slot] === item.id;
  const wearable = !!item.slot;
  const repeatable = item.kind === 'consumable';
  const missing = price - coins;

  let reason: string | null = null;
  if (pending) reason = null;
  else if (owned > 0 && !repeatable) reason = wearable ? null : 'Already in your inventory';
  else if (missing > 0) reason = `Need ${missing} more coin${missing === 1 ? '' : 's'}`;

  const descId = `shop-${item.id}-d`;
  return (
    <li className={`shop-card${owned > 0 ? ' is-owned' : ''}`}>
      <ItemArt item={item} size={52} />
      <div className="shop-body">
        <div className="shop-title">
          <h3>{item.name}</h3>
          {equipped ? <span className="tag tag--ok">Equipped</span> : owned > 0 ? <span className="tag tag--ok">Owned{owned > 1 ? ` ×${owned}` : ''}</span> : null}
        </div>
        <div className="shop-tags">
          <span className="tag">{KIND_LABEL[item.kind] ?? item.kind}</span>
          {item.slot ? <span className="tag">{SLOT_LABEL[item.slot]}</span> : null}
          {item.kind === 'collectible' ? <span className="tag tag--mock">MOCK / TEST ITEM</span> : null}
        </div>
        <p id={descId} className="shop-desc">
          {item.description}
        </p>
        <div className="shop-buy">
          <span className="price" aria-label={`${price} coins`}>
            <IconCoin size={15} /> {price}
          </span>
          {wearable && owned > 0 ? (
            <button type="button" className="btn btn--sm" aria-describedby={descId} onClick={() => gameClient.equip(item.slot!, equipped ? null : item.id)}>
              {equipped ? 'Unequip' : 'Equip'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!!reason || pending}
              aria-describedby={descId}
              onClick={onBuy}
              title={reason ?? undefined}
            >
              {pending ? 'Buying…' : repeatable && owned > 0 ? 'Buy another' : 'Buy'}
            </button>
          )}
        </div>
        {reason ? <div className="shop-reason">{reason}</div> : null}
      </div>
    </li>
  );
}
