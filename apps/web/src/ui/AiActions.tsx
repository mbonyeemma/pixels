import { ARRIVE_RADIUS } from '@pixels/shared';
import type { AiAction } from '../types';
import { runtime, useGame, type AiLine } from '../state';
import { gameClient } from '../net/client';
import { stopNavigation } from '../net/nav';
import { useExtras, type CardState } from '../net/extras';
import { useTick } from '../hooks/useTick';
import { openShop } from './focus';
import { IconCheck, IconCoin, IconFlag, IconStop, IconWalk } from './icons';
import { MISSION_TYPE_LABEL, formatDistance, mockSuffix } from './format';

type Props = { line: AiLine; index: number; action: AiAction };

const key = (line: AiLine, index: number) => `${line.id}:${index}`;

export default function AiActionCard({ line, index, action }: Props) {
  switch (action.type) {
    case 'navigate':
      return <NavigateCard action={action} />;
    case 'open_shop':
      return (
        <div className="card">
          <div className="card-main">
            <b>Opened the Pixel Market</b>
          </div>
          <button type="button" className="btn btn--xs" onClick={() => openShop(true)}>
            Open shop
          </button>
        </div>
      );
    case 'show_items':
      return (
        <div className="card card--stack">
          <div className="card-title">On sale at the Pixel Market</div>
          <ul className="mini-list">
            {action.items.map((it) => (
              <li key={it.id}>
                <span className="mini-name">
                  {it.name}
                  {it.kind === 'collectible' ? <span className="tag tag--mock">MOCK / TEST</span> : null}
                </span>
                <span className="price">
                  <IconCoin size={13} /> {it.price}
                </span>
              </li>
            ))}
          </ul>
          <div className="card-actions">
            <button type="button" className="btn btn--xs btn--accent" onClick={() => openShop(true)}>
              Open shop
            </button>
            <button type="button" className="btn btn--xs" onClick={() => gameClient.navigateTo('shop')}>
              Walk to the shop
            </button>
          </div>
          <div className="fineprint">Mock items, paid with mock coins.</div>
        </div>
      );
    case 'purchase_proposal':
      return <PurchaseCard line={line} index={index} action={action} />;
    case 'mission_offer':
      return <OfferCard line={line} index={index} action={action} />;
    case 'players':
      return (
        <div className="card card--stack">
          <div className="card-title">Players in town</div>
          {action.players.length === 0 ? (
            <div className="fineprint">Just you right now.</div>
          ) : (
            <ul className="mini-list">
              {action.players.map((p, i) => (
                <li key={`${p.name}${i}`}>
                  <span className="mini-name">{p.name}</span>
                  <span className="fineprint">{p.distance === null ? '' : formatDistance(p.distance)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'locations':
      return (
        <div className="card card--stack">
          <div className="card-title">Places to go</div>
          <ul className="mini-list">
            {action.locations.map((l) => (
              <li key={l.id}>
                <span className="mini-name" title={l.description}>
                  {l.name}
                </span>
                <button type="button" className="btn btn--xs" onClick={() => gameClient.navigateTo(l.id)}>
                  Go
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
    default:
      return null;
  }
}

function NavigateCard({ action }: { action: Extract<AiAction, { type: 'navigate' }> }) {
  useTick(500);
  const walking = runtime.navPath?.locationId === action.locationId;
  const arrived = !walking && Math.hypot(runtime.local.x - action.x, runtime.local.z - action.z) <= ARRIVE_RADIUS + 0.5;
  return (
    <div className="card">
      <IconWalk size={18} />
      <div className="card-main">
        <b>{walking ? 'Walking to' : arrived ? "You're at" : 'Route to'} {action.label}</b>
        {!arrived ? <span className="fineprint"> ({Math.round(action.distance)} m)</span> : null}
      </div>
      {walking ? (
        <button type="button" className="btn btn--xs btn--danger" onClick={stopNavigation}>
          <IconStop size={12} /> Stop
        </button>
      ) : !arrived ? (
        <button type="button" className="btn btn--xs" onClick={() => gameClient.navigateTo(action.locationId)}>
          Walk there
        </button>
      ) : null}
    </div>
  );
}

function PurchaseCard({ line, index, action }: Props & { action: Extract<AiAction, { type: 'purchase_proposal' }> }) {
  const k = key(line, index);
  const state = useExtras((s) => s.cards[k]);
  const setCard = useExtras((s) => s.setCard);
  const coins = useGame((s) => s.account?.coins ?? 0);
  const affordable = coins >= action.price;
  return (
    <div className="card card--stack card--purchase">
      <div className="card-title">
        Buy {action.name}?
      </div>
      <div className="card-line">
        <span className="price">
          <IconCoin size={14} /> {action.price}
        </span>
        <span className="fineprint">paid with coins (mock)</span>
      </div>
      {state === 'confirmed' ? (
        <div className="card-done">
          <IconCheck size={14} /> Purchase requested. The result shows in a message.
        </div>
      ) : state === 'cancelled' ? (
        <div className="card-done card-done--dim">Cancelled.</div>
      ) : (
        <>
          {!affordable ? <div className="shop-reason">Not enough coins (you have {coins}).</div> : null}
          <div className="card-actions">
            <button
              type="button"
              className="btn btn--xs btn--primary"
              disabled={!affordable}
              onClick={() => {
                setCard(k, 'confirmed' satisfies CardState);
                gameClient.buy(action.itemId);
              }}
            >
              Confirm
            </button>
            <button type="button" className="btn btn--xs" onClick={() => setCard(k, 'cancelled')}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function OfferCard({ line, index, action }: Props & { action: Extract<AiAction, { type: 'mission_offer' }> }) {
  const offer = action.offer;
  const k = key(line, index);
  const state = useExtras((s) => s.cards[k]);
  const setCard = useExtras((s) => s.setCard);
  const active = useGame((s) => s.mission);
  useTick(1000, !state);
  const expired = offer.expiresAt <= Date.now() + runtime.serverOffsetMs;
  const accepted = state === 'accepted' || (!!active && active.title === offer.title);
  return (
    <div className="card card--stack card--offer">
      <div className="card-title">
        <IconFlag size={14} /> {offer.title}
      </div>
      <p className="offer-desc">{offer.description}</p>
      <div className="offer-meta">
        <span className="tag">{MISSION_TYPE_LABEL[offer.type] ?? offer.type}</span>
        <span className="tag">~{offer.estimatedMinutes} min</span>
        <span className="tag tag--mock">Mock reward</span>
      </div>
      {offer.objectives.length ? (
        <ol className="offer-obj">
          {offer.objectives.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ol>
      ) : null}
      <div className="offer-reward">
        <IconCoin size={14} /> Reward: {mockSuffix(offer.reward.label)}
      </div>
      {accepted ? (
        <div className="card-done">
          <IconCheck size={14} /> Mission accepted. Follow the marker on the minimap.
        </div>
      ) : state === 'declined' ? (
        <div className="card-done card-done--dim">Declined.</div>
      ) : expired ? (
        <div className="card-done card-done--dim">This offer has expired. Ask for a new one.</div>
      ) : (
        <>
          {active ? <div className="shop-reason">Finish or abandon your current mission first.</div> : null}
          <div className="card-actions">
            <button
              type="button"
              className="btn btn--xs btn--primary"
              disabled={!!active}
              onClick={() => {
                setCard(k, 'accepted');
                gameClient.acceptMission(offer.offerId);
              }}
            >
              Accept
            </button>
            <button
              type="button"
              className="btn btn--xs"
              onClick={() => {
                setCard(k, 'declined');
                useGame.setState({ offers: useGame.getState().offers.filter((o) => o.offerId !== offer.offerId) });
              }}
            >
              Decline
            </button>
          </div>
        </>
      )}
    </div>
  );
}

