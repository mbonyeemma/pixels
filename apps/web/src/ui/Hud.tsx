import { useGlobalKeys } from '../hooks/useGlobalKeys';
import PlayerCard from './PlayerCard';
import MissionTracker from './MissionTracker';
import ClockChip from './ClockChip';
import ToastStack from './ToastStack';
import TopButtons from './TopButtons';
import AiPanel from './AiPanel';
import InventoryPanel from './InventoryPanel';
import Minimap from './Minimap';
import ChatBox from './ChatBox';
import ControlsGuide from './ControlsGuide';
import InteractionPrompt from './InteractionPrompt';
import EmoteBar from './EmoteBar';
import ShopModal from './ShopModal';
import HelpModal from './HelpModal';
import { DisconnectedOverlay, ReconnectBanner } from './ConnectionOverlay';

/** All DOM overlays. The container ignores the pointer; only the panels inside accept it. */
export default function Hud() {
  useGlobalKeys();
  return (
    <div className="hud">
      <div className="hud-tl">
        <PlayerCard />
        <MissionTracker />
      </div>
      <div className="hud-tc">
        <ClockChip />
        <ReconnectBanner />
        <ToastStack />
      </div>
      <div className="hud-tr">
        <TopButtons />
      </div>
      <div className="hud-right">
        <AiPanel />
        <InventoryPanel />
      </div>
      <Minimap />
      <div className="hud-bl">
        <ChatBox />
        <ControlsGuide />
      </div>
      <div className="hud-bc">
        <InteractionPrompt />
        <EmoteBar />
      </div>
      <ShopModal />
      <HelpModal />
      <DisconnectedOverlay />
    </div>
  );
}
