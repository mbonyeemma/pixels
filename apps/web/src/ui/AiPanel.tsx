import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AI_MESSAGE_MAX_LENGTH } from '@pixels/shared';
import { useGame, type AiLine } from '../state';
import { gameClient } from '../net/client';
import { useExtras } from '../net/extras';
import { useTypingHandlers } from '../hooks/useTyping';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { closePanel, consumeAiFocus } from './focus';
import { IconClose, IconMic, IconSend, IconSpark } from './icons';
import AiActionCard from './AiActions';

const CHIPS = ['Where is the shop?', 'Take me to the shop', 'Show me what I can buy', "I'm bored, give me something fun", 'Give me a treasure hunt', "Who's online?"];
const MISSION_PROMPT = "I'm bored. Give me a mission I can complete.";

const PROVIDER_LABEL: Record<string, string> = { rules: 'Offline guide', anthropic: 'AI guide' };

export default function AiPanel() {
  const open = useGame((s) => s.panel === 'ai');
  return open ? <AiPanelInner /> : null;
}

function AiPanelInner() {
  const lines = useGame((s) => s.ai);
  const busy = useGame((s) => s.aiBusy);
  const usage = useExtras((s) => s.aiUsage);
  const [text, setText] = useState('');
  const [ideas, setIdeas] = useState(() => useGame.getState().ai.length === 0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typing = useTypingHandlers();
  const speech = useSpeechInput((t) => setText(t.slice(0, AI_MESSAGE_MAX_LENGTH)));

  useEffect(() => {
    if (consumeAiFocus()) inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const last = lines[lines.length - 1];
    const nodes = el.querySelectorAll<HTMLElement>('.ai-msg--ai[data-line]');
    // a fresh guide reply is read from its first line; everything else sticks to the bottom
    if (last?.from === 'ai' && !busy && nodes.length) el.scrollTop = Math.max(0, nodes[nodes.length - 1].offsetTop - 10);
    else el.scrollTop = el.scrollHeight;
  }, [lines.length, busy]);

  const send = (msg: string) => {
    const m = msg.trim();
    if (!m || busy) return;
    speech.stop();
    setIdeas(false);
    void gameClient.askAi(m);
  };

  const submit = () => {
    if (!text.trim() || busy) return;
    send(text);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  const empty = lines.length === 0;
  return (
    <aside className="panel glass dock ai" aria-label="Town Guide">
      <header className="dock-head">
        <div className="dock-title">
          <IconSpark size={18} />
          <h2>Town Guide</h2>
        </div>
        {usage ? (
          <span className="fineprint" title="Town Guide questions left today">
            {usage.remainingToday}/{usage.limitPerDay} left today
          </span>
        ) : null}
        <button type="button" className="icon-btn" aria-label="Close Town Guide" onClick={closePanel}>
          <IconClose />
        </button>
      </header>

      <div className="ai-list" ref={listRef} role="log" aria-live="polite" aria-relevant="additions text" aria-busy={busy} aria-label="Conversation with the Town Guide">
        {empty ? (
          <div className="ai-msg ai-msg--ai">
            <p>Hi! I&apos;m your Town Guide. Ask me where things are, what you can buy, who&apos;s around, or for something fun to do.</p>
            <p className="fineprint">I can walk you places and suggest missions. I can never spend your coins without your Confirm.</p>
          </div>
        ) : null}
        {lines.map((l) => (
          <AiMessage key={l.id} line={l} />
        ))}
        {busy ? (
          <div className="ai-msg ai-msg--ai ai-thinking" role="status">
            <span className="dots-anim" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Thinking…</span>
          </div>
        ) : null}
      </div>

      <div className="ai-compose">
        {ideas ? (
          <div className="chips" role="group" aria-label="Example questions">
            {CHIPS.map((c) => (
              <button key={c} type="button" className="chip-btn" disabled={busy} onClick={() => send(c)}>
                {c}
              </button>
            ))}
          </div>
        ) : null}
        <div className="ai-quick">
          <button type="button" className="btn btn--accent btn--sm" disabled={busy} onClick={() => send(MISSION_PROMPT)}>
            Give me a mission
          </button>
          <button type="button" className="btn btn--ghost btn--sm" aria-expanded={ideas} onClick={() => setIdeas((v) => !v)}>
            {ideas ? 'Hide ideas' : 'Ideas'}
          </button>
        </div>
        <div className="ai-input">
          <input
            ref={inputRef}
            type="text"
            value={text}
            maxLength={AI_MESSAGE_MAX_LENGTH}
            placeholder={speech.state === 'listening' ? 'Listening… speak now' : 'Ask the Town Guide…'}
            aria-label="Message to the Town Guide"
            autoComplete="off"
            spellCheck
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={typing.onFocus}
            onBlur={typing.onBlur}
          />
          <button
            type="button"
            className={`icon-btn icon-btn--mic${speech.state === 'listening' ? ' is-listening' : ''}`}
            onClick={speech.toggle}
            disabled={!speech.supported}
            aria-pressed={speech.state === 'listening'}
            aria-label={
              !speech.supported
                ? "Voice input isn't supported in this browser"
                : speech.state === 'listening'
                  ? 'Stop listening'
                  : 'Speak your question'
            }
            title={!speech.supported ? "Voice input isn't supported in this browser. Typing works everywhere." : speech.state === 'listening' ? 'Stop listening' : 'Speak your question (asks for microphone permission)'}
          >
            <IconMic size={18} />
          </button>
          <button type="button" className="btn btn--primary btn--icon" onClick={submit} disabled={busy || !text.trim()} aria-label="Send message">
            <IconSend size={18} />
          </button>
        </div>
        {speech.state === 'listening' || speech.message ? (
          <div className="ai-voice-msg fineprint" role="status" aria-live="polite">
            {speech.state === 'listening' ? 'Listening… your words appear above. Review them, then press Send.' : speech.message}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function AiMessage({ line }: { line: AiLine }) {
  if (line.from === 'you') {
    return <div className="ai-msg ai-msg--you">{line.text}</div>;
  }
  return (
    <div className={`ai-msg ai-msg--ai${line.error ? ' is-error' : ''}`} data-line>
      <p>{line.text}</p>
      {line.interpretation ? (
        <p className="ai-interp">
          <span>Understood as:</span> {line.interpretation}
        </p>
      ) : null}
      {line.plan && line.plan.length ? (
        <div className="ai-plan">
          <div className="ai-plan-h">Plan:</div>
          <ol>
            {line.plan.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {line.actions?.map((a, i) => <AiActionCard key={i} line={line} index={i} action={a} />)}
      {line.provider && !line.error ? <div className="ai-prov">{PROVIDER_LABEL[line.provider] ?? line.provider}</div> : null}
    </div>
  );
}
