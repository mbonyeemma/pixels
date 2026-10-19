import { useRef } from 'react';
import { useGame } from '../state';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { closePanel } from './focus';
import { IconClose } from './icons';
import { ControlList } from './ControlsGuide';

export default function HelpModal() {
  const open = useGame((s) => s.panel === 'help');
  return open ? <HelpDialog /> : null;
}

function HelpDialog() {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && closePanel()}>
      <div ref={ref} className="dialog glass help" role="dialog" aria-modal="true" aria-labelledby="help-title" tabIndex={-1}>
        <header className="dialog-head">
          <div>
            <h2 id="help-title">How to play</h2>
            <p className="dialog-sub">Welcome to Pixels. Wander, chat, shop and explore.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close help" data-autofocus onClick={closePanel}>
            <IconClose />
          </button>
        </header>
        <div className="help-cols">
          <section>
            <h3 className="section-h">Controls</h3>
            <ControlList />
          </section>
          <section>
            <h3 className="section-h">Things to do</h3>
            <ul className="bullets">
              <li>Ask the AI Town Guide (<kbd>T</kbd>) where things are, what you can buy, or for a mission.</li>
              <li>Missions pay out mock coins. Accept one from the Guide, then follow the pulsing marker on the minimap.</li>
              <li>The gold pin on the minimap is the Pixel Market. Click any pin to walk there automatically; move yourself to cancel.</li>
              <li>Press <kbd>E</kbd> near the market counter to open the shop. Wear what you buy from your inventory.</li>
              <li>Press <kbd>Enter</kbd> to chat with everyone in town.</li>
            </ul>
            <h3 className="section-h">Good to know</h3>
            <ul className="bullets">
              <li>Coins and items are a mock, in-game economy. They have no real-world value and nothing is recorded on a blockchain.</li>
              <li>Your email is only used as an account ID. There is no password in this preview and other players never see it.</li>
              <li>If the Guide is unavailable, everything else keeps working.</li>
            </ul>
          </section>
        </div>
        <footer className="dialog-foot row">
          <button type="button" className="btn btn--primary" onClick={closePanel}>
            Got it
          </button>
          <span className="fineprint">
            Tip: <kbd>Esc</kbd> closes any panel.
          </span>
        </footer>
      </div>
    </div>
  );
}
