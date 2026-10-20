import { useGame } from '../state';
import { gameClient } from '../net/client';
import { togglePanel } from './focus';
import HudButton from './HudButton';
import QualityToggle from './QualityToggle';
import { IconBag, IconHelp, IconLogout, IconSpark } from './icons';
import { WalletToolbarSlot } from '../wallet/slots';

export default function TopButtons() {
  const panel = useGame((s) => s.panel);
  return (
    <nav className="panel glass toolbar" aria-label="Game menu">
      <HudButton icon={<IconHelp />} label="Help" shortcut="H" active={panel === 'help'} onClick={() => togglePanel('help')} />
      <HudButton icon={<IconBag />} label="Inventory" shortcut="I" active={panel === 'inventory'} onClick={() => togglePanel('inventory')} />
      <HudButton icon={<IconSpark />} label="AI Guide" shortcut="T" active={panel === 'ai'} onClick={() => togglePanel('ai')} />
      <WalletToolbarSlot />
      <QualityToggle />
      <HudButton icon={<IconLogout />} label="Log out" onClick={() => gameClient.logout()} className="hud-btn--danger" />
    </nav>
  );
}
