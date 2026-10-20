import { useEffect, useMemo, useRef, useState } from 'react';
import { shopItems, type ShopItem } from '@pixels/shared';
import { runtime, useGame } from '../state';
import { gameClient } from '../net/client';
import { distanceToShopCounter, isFarFromShop } from '../net/shopRange';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useTick } from '../hooks/useTick';
import { closePanel } from './focus';
import { IconClose, IconCoin } from './icons';
import { KIND_LABEL, SLOT_LABEL } from './format';
import ItemArt from './ItemArt';
import { PayButtonSlot, ShopResumeSlot } from '../wallet/slots';
import { usePaymentsEnabled } from '../wallet/config';
import { DEVNET_FAUCET_URL } from '../wallet/format';

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
  const lastToast = useGame((s) => s.toasts.at(-1)?.id);
  useTick(400);
  const solana = usePaymentsEnabled();
  const far = isFarFromShop(runtime.local.x, runtime.local.z);
  const meters = Math.round(distanceToShopCounter(runtime.local.x, runtime.local.z));

  // a server answer (coins, inventory or a toast such as "too far") means the purchase is settled
  useEffect(() => setPending(null), [coins, invKey, lastToast]);
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

        {far ? (
          <div className="shop-away" role="status">
            <span>
              You&apos;re about {meters} m from the shop counter. You can browse from here, but you need to stand at the counter to buy.
            </span>
            <button
              type="button"
              className="btn btn--sm btn--accent"
              onClick={() => {
                gameClient.navigateTo('shop');
                closePanel();
              }}
            >
              Walk me to the counter
            </button>
          </div>
        ) : null}

        <ul className="shop-grid">
          {items.map((item) => (
            <ShopCard
              key={item.id}
              item={item}
              coins={coins}
              far={far}
              pending={pending === item.id}
              onBuy={() => {
                setPending(item.id);
                gameClient.buy(item.id);
              }}
            />
          ))}
        </ul>

        <ShopResumeSlot />
        <footer className="dialog-foot">
          Mock economy: coins and items are in-game only, have no real-world value, and nothing here is recorded on a blockchain.
          {solana ? (
            <span className="shop-devnet-note">
              <strong>DEVNET TEST — no real value.</strong> The optional &quot;Pay … SOL&quot; buttons use free Solana Devnet test SOL, approved in your own wallet. Need some?{' '}
              <a href={DEVNET_FAUCET_URL} target="_blank" rel="noreferrer noopener">
                faucet.solana.com
              </a>
              .
            </span>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function ShopCard({ item, coins, far, pending, onBuy }: { item: ShopItem; coins: number; far: boolean; pending: boolean; onBuy: () => void }) {
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
  else if (far) reason = 'Walk to the shop counter to buy';

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
        <PayButtonSlot item={item} disabled={owned > 0 && !repeatable} />
      </div>
    </li>
  );
}
