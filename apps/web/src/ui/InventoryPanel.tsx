import { EQUIP_SLOTS, ITEMS, itemById } from '@pixels/shared';
import { useGame } from '../state';
import { gameClient } from '../net/client';
import { closePanel } from './focus';
import { IconClose } from './icons';
import { KIND_LABEL, SLOT_LABEL } from './format';
import ItemArt from './ItemArt';

export default function InventoryPanel() {
  const open = useGame((s) => s.panel === 'inventory');
  const account = useGame((s) => s.account);
  if (!open || !account) return null;

  const owned = Object.entries(account.inventory)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ id, n, item: itemById(id) }))
    .sort((a, b) => ITEMS.findIndex((i) => i.id === a.id) - ITEMS.findIndex((i) => i.id === b.id));

  return (
    <aside className="panel glass dock inventory" aria-label="Inventory">
      <header className="dock-head">
        <h2>Inventory</h2>
        <button type="button" className="icon-btn" aria-label="Close inventory" onClick={closePanel}>
          <IconClose />
        </button>
      </header>

      <div className="dock-scroll">
        <h3 className="section-h">Wearing</h3>
        <ul className="slots">
          {EQUIP_SLOTS.map((slot) => {
            const id = account.equipped[slot];
            const item = id ? itemById(id) : undefined;
            return (
              <li key={slot} className="slot">
                <span className="slot-name">{SLOT_LABEL[slot]}</span>
                {item ? (
                  <>
                    <span className="slot-item">
                      <ItemArt item={item} size={26} /> {item.name}
                    </span>
                    <button type="button" className="btn btn--xs" onClick={() => gameClient.equip(slot, null)}>
                      Unequip
                    </button>
                  </>
                ) : (
                  <span className="slot-empty">Nothing</span>
                )}
              </li>
            );
          })}
        </ul>

        <h3 className="section-h">Your items</h3>
        {owned.length === 0 ? (
          <div className="empty">
            <p>Nothing here yet. Earn coins with missions, then visit the Pixel Market.</p>
            <button
              type="button"
              className="btn btn--sm btn--accent"
              onClick={() => {
                gameClient.navigateTo('shop');
                closePanel();
              }}
            >
              Walk me to the shop
            </button>
          </div>
        ) : (
          <ul className="inv-list">
            {owned.map(({ id, n, item }) => {
              const wearing = !!item?.slot && account.equipped[item.slot] === id;
              return (
                <li key={id} className="inv-item">
                  {item ? <ItemArt item={item} size={40} /> : <div className="item-art" style={{ width: 40, height: 40 }} />}
                  <div className="inv-body">
                    <div className="inv-name">
                      {item?.name ?? id}
                      {n > 1 ? <span className="inv-n"> ×{n}</span> : null}
                    </div>
                    <div className="shop-tags">
                      <span className="tag">{item ? (KIND_LABEL[item.kind] ?? item.kind) : 'Item'}</span>
                      {item?.kind === 'collectible' ? <span className="tag tag--mock">MOCK / TEST ITEM</span> : null}
                      {item?.kind === 'badge' ? <span className="tag tag--mock">MOCK BADGE</span> : null}
                      {wearing ? <span className="tag tag--ok">Equipped</span> : null}
                    </div>
                  </div>
                  {item?.slot ? (
                    <button type="button" className="btn btn--xs" onClick={() => gameClient.equip(item.slot!, wearing ? null : id)}>
                      {wearing ? 'Unequip' : 'Equip'}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <p className="fineprint">Items are mock, in-game only and have no real-world value.</p>
      </div>
    </aside>
  );
}
