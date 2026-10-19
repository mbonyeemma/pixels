import type { AiAction, AiErrorResponse, AiResponse, MissionOfferView } from '../types';
import type { AiLine, Panel } from '../state';

const CODES = ['rate_limited', 'quota_exceeded', 'timeout', 'unavailable', 'bad_request', 'unauthorized'] as const;

export function isAiError(x: unknown): x is AiErrorResponse {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.error === 'string' && typeof o.code === 'string';
}

export function isAiResponse(x: unknown): x is AiResponse {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.reply === 'string';
}

/** Friendly, non-technical text for every AI failure. The game stays fully playable without the guide. */
export function aiErrorMessage(err: Partial<AiErrorResponse> | null | undefined, httpStatus?: number): string {
  const code = err?.code ?? (httpStatus === 429 ? 'rate_limited' : httpStatus === 401 ? 'unauthorized' : httpStatus === 400 ? 'bad_request' : 'unavailable');
  switch (code) {
    case 'rate_limited': {
      const s = err?.retryAfterSec;
      return s && s > 0 ? `You're asking a little fast. Try again in ${Math.ceil(s)}s.` : "You're asking a little fast. Give it a few seconds and try again.";
    }
    case 'quota_exceeded':
      return "You've used all of today's Town Guide questions. They reset tomorrow. You can keep exploring, shopping and chatting meanwhile.";
    case 'timeout':
      return 'The Town Guide took too long to answer. Please try again in a moment.';
    case 'bad_request':
      return err?.error && err.error.length < 140 ? err.error : "I couldn't understand that message. Try rephrasing it.";
    case 'unauthorized':
      return 'Your session has expired. Please sign in again.';
    case 'unavailable':
    default:
      return 'The Town Guide is unavailable right now. The rest of the game still works: you can explore, shop and chat.';
  }
}

export const isKnownAiCode = (c: unknown): boolean => (CODES as readonly string[]).includes(c as string);

let aiSeq = 1;
export const nextAiId = (): string => `ai${Date.now().toString(36)}${(aiSeq++).toString(36)}`;

export function responseToLine(res: AiResponse, id: string = nextAiId()): AiLine {
  return {
    id,
    from: 'ai',
    text: res.reply,
    interpretation: res.interpretation || undefined,
    plan: Array.isArray(res.plan) && res.plan.length ? res.plan : undefined,
    actions: Array.isArray(res.actions) ? res.actions : [],
    provider: res.provider,
  };
}

export interface AiActionDeps {
  navigateTo: (locationId: string) => void;
  setPanel: (p: Panel) => void;
  getPanel: () => Panel;
  setReturnPanel: (p: Panel) => void;
  addOffer: (offer: MissionOfferView) => void;
  notify: (text: string) => void;
}

/**
 * Executes only the AI actions that are safe to run automatically on the client:
 *  - navigate     -> walk there (client-side pathing only, no server state)
 *  - open_shop    -> open the shop UI (the player still has to press Buy)
 *  - mission_offer-> record the offer; the player must press Accept in the AI panel
 * purchase_proposal / show_* are render-only (a proposal needs an explicit Confirm click).
 */
export function executeAiActions(actions: AiAction[], deps: AiActionDeps): void {
  let navigated = false;
  for (const a of actions) {
    switch (a.type) {
      case 'navigate':
        if (!navigated) {
          navigated = true;
          deps.navigateTo(a.locationId);
        }
        break;
      case 'open_shop': {
        const cur = deps.getPanel();
        deps.setReturnPanel(cur === 'ai' ? 'ai' : 'none');
        deps.setPanel('shop');
        break;
      }
      case 'mission_offer':
        deps.addOffer(a.offer);
        deps.notify(`New mission offer: ${a.offer.title}. Review it in the Town Guide.`);
        break;
      default:
        break;
    }
  }
}

export const AI_BUSY_TEXT = 'The Town Guide is still thinking about your last question.';
