import { useGame } from '../state';
import { IconCoin } from './icons';
import { splitDisplayName } from './format';
import ConnectionChip from './ConnectionChip';
import { WalletChipSlot } from '../wallet/slots';

export default function PlayerCard() {
  const account = useGame((s) => s.account);
  const online = useGame((s) => Object.keys(s.players).length);
  if (!account) return null;
  const { name, tag } = splitDisplayName(account.displayName);
  return (
    <section className="panel glass player-card" aria-label="Player">
      <div className="player-row">
        <div className="avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </div>
        <div className="player-id">
          <div className="player-name" title={account.displayName}>
            {name}
            <span className="player-tag">{tag}</span>
          </div>
          <div className="coins" aria-label={`${account.coins} coins (mock in-game currency)`} title="Coins are a mock in-game currency with no real-world value">
            <IconCoin size={16} />
            <span key={account.coins} className="coins-value">
              {account.coins.toLocaleString()}
            </span>
            <span className="coins-unit">coins</span>
          </div>
          <WalletChipSlot />
        </div>
        <div className="online" title="Players in town">
          <span className="online-n">{online}</span>
          <span className="online-l">online</span>
        </div>
      </div>
      <ConnectionChip />
    </section>
  );
}
