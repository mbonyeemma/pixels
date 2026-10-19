import { INTERACT_RADIUS, SHOP_COUNTER, itemById, type EquipSlot, type ShopItem } from '@pixels/shared';
import type { AccountRecord, Database } from './db';
import type { Logger } from './log';

/** Maximum stack for consumables. */
export const MAX_STACK = 99;
/** How close (to the counter's footprint) a player must be to buy. */
export const SHOP_RANGE = INTERACT_RADIUS + 1;

export type ChargeResult = { ok: true } | { ok: false; reason: string };

/**
 * The seam between the shop and "how things are paid for". Today only the in-game `coins` provider exists.
 * A future Solana (Devnet) provider implements the same interface; it must never trust a price from a client.
 */
export interface PaymentProvider {
  readonly id: string;
  /** Take `price` from the account. On success the shop grants the item. */
  charge(account: AccountRecord, price: number, item: ShopItem): Promise<ChargeResult>;
}

export const coinsProvider: PaymentProvider = {
  id: 'coins',
  async charge(account, price) {
    if (!Number.isSafeInteger(price) || price < 0) return { ok: false, reason: 'Invalid price.' };
    if (account.coins < price) return { ok: false, reason: `Not enough coins (you have ${account.coins}, need ${price}).` };
    account.coins -= price;
    return { ok: true };
  },
};

/** Distance from a point to the shop counter's footprint (0 when standing on it). */
export function distanceToShopCounter(x: number, z: number): number {
  const dx = Math.max(Math.abs(x - SHOP_COUNTER.x) - SHOP_COUNTER.w / 2, 0);
  const dz = Math.max(Math.abs(z - SHOP_COUNTER.z) - SHOP_COUNTER.d / 2, 0);
  return Math.hypot(dx, dz);
}

export const isNearShopCounter = (x: number, z: number, range = SHOP_RANGE): boolean => distanceToShopCounter(x, z) <= range;

export interface PurchaseResult {
  ok: boolean;
  itemId: string;
  message: string;
  /** the player's coin balance after the attempt */
  coins: number;
}

export type Purchasable = { ok: true; item: ShopItem & { price: number } } | { ok: false; error: string };

export type EquipResult = { ok: true } | { ok: false; error: string };

export class Shop {
  private readonly pending = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly log: Logger,
    private readonly provider: PaymentProvider = coinsProvider,
  ) {}

  get paymentProviderId(): string {
    return this.provider.id;
  }

  /** Can this account buy this item right now (catalogue, ownership and stack rules; not coins or range)? */
  checkPurchasable(account: AccountRecord, itemId: string): Purchasable {
    const item = itemById(itemId);
    if (!item) return { ok: false, error: 'That item does not exist.' };
    if (item.price === null || !Number.isSafeInteger(item.price) || item.price < 0) {
      return { ok: false, error: `${item.name} is not for sale.` };
    }
    const owned = account.inventory[item.id] ?? 0;
    if (item.kind === 'consumable') {
      if (owned >= MAX_STACK) return { ok: false, error: `You cannot carry more than ${MAX_STACK} ${item.name}.` };
    } else if (owned > 0) {
      return { ok: false, error: `You already own ${item.name}.` };
    }
    return { ok: true, item: item as ShopItem & { price: number } };
  }

  /**
   * Buy one item. The price always comes from the server catalogue; `pos` is the server-side position of the player
   * (null if they have none, e.g. not connected), which must be within range of the counter.
   */
  async purchase(account: AccountRecord, itemId: string, pos: { x: number; z: number } | null): Promise<PurchaseResult> {
    const fail = (message: string): PurchaseResult => ({ ok: false, itemId, message, coins: account.coins });
    if (!pos || !isNearShopCounter(pos.x, pos.z)) return fail('You need to be at the shop counter to buy things.');
    if (this.pending.has(account.id)) return fail('Another purchase is still in progress.');

    const check = this.checkPurchasable(account, itemId);
    if (!check.ok) return fail(check.error);
    const { item } = check;

    this.pending.add(account.id);
    try {
      const charged = await this.provider.charge(account, item.price, item);
      if (!charged.ok) return fail(charged.reason);
      account.inventory[item.id] = (account.inventory[item.id] ?? 0) + 1;
      this.db.save();
      this.log.info('purchase', { account: account.id, item: item.id, price: item.price, provider: this.provider.id });
      return { ok: true, itemId, message: `Bought ${item.name} for ${item.price} coins.`, coins: account.coins };
    } catch (err) {
      this.log.error('purchase failed', { account: account.id, item: itemId, err });
      return fail('The purchase could not be completed.');
    } finally {
      this.pending.delete(account.id);
    }
  }

  /** Equip (itemId) or unequip (null) a slot. The item must be a cosmetic for exactly that slot and be owned. */
  equip(account: AccountRecord, slot: EquipSlot, itemId: string | null): EquipResult {
    if (itemId === null) {
      delete account.equipped[slot];
      this.db.save();
      return { ok: true };
    }
    const item = itemById(itemId);
    if (!item) return { ok: false, error: 'That item does not exist.' };
    if (item.kind !== 'cosmetic' || !item.slot) return { ok: false, error: `${item.name} cannot be worn.` };
    if (item.slot !== slot) return { ok: false, error: `${item.name} does not go in the ${slot} slot.` };
    if ((account.inventory[item.id] ?? 0) < 1) return { ok: false, error: `You do not own ${item.name}.` };
    account.equipped[slot] = item.id;
    this.db.save();
    return { ok: true };
  }
}
