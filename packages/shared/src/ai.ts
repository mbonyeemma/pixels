import type { AiAction, MissionOfferView } from './protocol';
import type { MissionProposalInput } from './missions';
import type { ShopItemView } from './catalog';

/**
 * The only capabilities the AI layer may use. The game server implements this interface on top of its own
 * validated services; the AI never sees databases, wallets or the filesystem.
 */
export interface AiGameApi {
  /** requesting player's context (never includes email or other private data) */
  getPlayerContext(): {
    displayName: string;
    x: number;
    z: number;
    coins: number;
    nearestLocation: { id: string; name: string; distance: number } | null;
    nearbyInteractables: { id: string; name: string; distance: number }[];
    activeMission: { title: string; type: string; currentObjective: string } | null;
    playersOnline: number;
  };
  /** public, non-hidden locations only */
  listLocations(): { id: string; name: string; description: string; distance: number }[];
  /** resolve a free-text name/alias to a public location; null if unknown */
  findLocation(query: string): { id: string; name: string; description: string; x: number; z: number; distance: number } | null;
  /** validate the location, compute a walking path length and produce the navigate action */
  navigateTo(locationId: string): { ok: true; action: Extract<AiAction, { type: 'navigate' }> } | { ok: false; error: string };
  /** validates the shop is reachable/accessible and returns the open_shop action */
  openShop(): { ok: true; action: Extract<AiAction, { type: 'open_shop' }> } | { ok: false; error: string };
  /** items and prices straight from the trusted catalogue */
  listShopItems(): ShopItemView[];
  /** purchase proposals only: the player must confirm in the UI; the AI cannot buy */
  proposePurchase(itemId: string): { ok: true; action: Extract<AiAction, { type: 'purchase_proposal' }> } | { ok: false; error: string };
  /** mission templates currently supported (id, type, short description) */
  listAvailableQuests(): { type: string; description: string; examples: string[] }[];
  /** validates + stores a mission offer (not started). Reward is chosen by the server. */
  createMissionOffer(proposal: MissionProposalInput): { ok: true; offer: MissionOfferView } | { ok: false; error: string };
  /** other players in the room: display names and rough distance only */
  findPlayers(): { name: string; distance: number | null }[];
}

export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON schema for the tool input */
  input_schema: Record<string, unknown>;
}
