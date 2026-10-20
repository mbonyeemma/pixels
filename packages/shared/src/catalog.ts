import type { EquipSlot } from './constants';

export type ItemKind = 'cosmetic' | 'consumable' | 'collectible' | 'badge';

export interface ShopItem {
  id: string;
  name: string;
  description: string;
  kind: ItemKind;
  /** coin price; null = not sold in the shop (reward only) */
  price: number | null;
  /**
   * Optional price in lamports of DEVNET SOL (1 SOL = 1_000_000_000 lamports). Only used by the optional,
   * feature-flagged Solana Devnet payments (test network, no real value). Items stay payable with coins too.
   */
  priceLamports?: number;
  slot?: EquipSlot;
  /** colour used when rendering the equipped cosmetic */
  color?: string;
  /** collectibles are test items: never recorded on a blockchain unless `onChain` is true */
  onChain: false;
}

/** Authoritative item catalogue. The AI and the client can only *display* this; prices are never taken from them. */
export const ITEMS: ShopItem[] = [
  { id: 'coffee', name: 'Pixel Coffee', description: 'A hot cup. Purely refreshing.', kind: 'consumable', price: 5, onChain: false },
  { id: 'explorer_cap', name: 'Explorer Cap', description: 'A sturdy red cap for adventurers.', kind: 'cosmetic', price: 40, priceLamports: 2_000_000, slot: 'hat', color: '#c0392b', onChain: false },
  { id: 'round_shades', name: 'Round Shades', description: 'Dark round sunglasses.', kind: 'cosmetic', price: 60, slot: 'face', color: '#111111', onChain: false },
  { id: 'neon_sneakers', name: 'Neon Sneakers', description: 'Glowing cyan trainers.', kind: 'cosmetic', price: 80, slot: 'shoes', color: '#00e5ff', onChain: false },
  { id: 'sunset_hoodie', name: 'Sunset Hoodie', description: 'A warm orange hoodie.', kind: 'cosmetic', price: 120, priceLamports: 5_000_000, slot: 'jacket', color: '#ff7043', onChain: false },
  { id: 'genesis_pixel', name: 'Genesis Pixel (test collectible)', description: 'A shiny test collectible. Mock item: not recorded on any blockchain.', kind: 'collectible', price: 250, priceLamports: 10_000_000, onChain: false },
  { id: 'explorer_badge', name: 'Treasure Hunter Badge', description: 'Awarded for finishing a treasure hunt. Not for sale.', kind: 'badge', price: null, onChain: false },
];

export const itemById = (id: string): ShopItem | undefined => ITEMS.find((i) => i.id === id);
export const shopItems = (): ShopItem[] => ITEMS.filter((i) => i.price !== null);

/** Is this item purchasable with Devnet SOL (has a positive integer lamport price)? */
export const hasLamportPrice = (i: ShopItem): i is ShopItem & { priceLamports: number } =>
  typeof i.priceLamports === 'number' && Number.isSafeInteger(i.priceLamports) && i.priceLamports > 0;

export interface ShopItemView {
  id: string;
  name: string;
  description: string;
  kind: ItemKind;
  price: number;
  /** Devnet SOL price in lamports (optional payments feature; test network, no real value) */
  priceLamports?: number;
  slot?: EquipSlot;
  color?: string;
  mock: true;
}
export const toShopItemView = (i: ShopItem): ShopItemView => ({
  id: i.id,
  name: i.name,
  description: i.description,
  kind: i.kind,
  price: i.price ?? 0,
  ...(hasLamportPrice(i) ? { priceLamports: i.priceLamports } : {}),
  slot: i.slot,
  color: i.color,
  mock: true,
});
