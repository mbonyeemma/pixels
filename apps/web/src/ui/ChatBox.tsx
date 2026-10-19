import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CHAT_MAX_LENGTH } from '@pixels/shared';
import { useGame } from '../state';
import { gameClient } from '../net/client';
import { sanitizeChat } from '../net/sanitize';
import { useTypingHandlers } from '../hooks/useTyping';
import { focusGame } from './focus';
import { nameColor } from './format';

const FADE_AFTER_MS = 9000;
const VISIBLE_LINES = 60;

export default function ChatBox() {
  const chat = useGame((s) => s.chat);
  const selfId = useGame((s) => s.selfId);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [faded, setFaded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const typing = useTypingHandlers({ chat: true });

  // keep the newest line in view and wake the box up whenever something happens
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFaded(false);
    if (focused || hovered) return;
    const id = setTimeout(() => setFaded(true), FADE_AFTER_MS);
    return () => clearTimeout(id);
  }, [chat.length, focused, hovered]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const clean = sanitizeChat(text);
      if (clean) gameClient.sendChat(clean);
      setText('');
      focusGame(); // sending (or an empty Enter) hands control back to the game
    }
  };

  const lines = chat.slice(-VISIBLE_LINES);
  return (
    <section
      className={`chat${focused ? ' is-focused' : ''}${faded && !focused && !hovered ? ' is-faded' : ''}`}
      aria-label="Chat"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ul className="chat-lines panel" ref={listRef} role="log" aria-live="polite" aria-label="Chat messages" tabIndex={-1}>
        {lines.map((l) =>
          l.system ? (
            <li key={l.id} className="chat-line chat-line--sys">
              {l.text}
            </li>
          ) : (
            <li key={l.id} className={`chat-line${l.playerId === selfId ? ' chat-line--self' : ''}`}>
              <span className="chat-name" style={{ color: nameColor(l.name) }}>
                {l.name}
              </span>
              <span className="chat-text">{l.text}</span>
            </li>
          ),
        )}
      </ul>
      <div className="chat-input panel glass">
        <input
          data-chat-input
          type="text"
          value={text}
          maxLength={CHAT_MAX_LENGTH}
          placeholder={focused ? 'Type a message, Enter to send, Esc to cancel' : 'Press Enter to chat'}
          aria-label="Chat message"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true);
            typing.onFocus();
          }}
          onBlur={() => {
            setFocused(false);
            typing.onBlur();
          }}
        />
        {text.length > CHAT_MAX_LENGTH - 30 ? (
          <span className="chat-count" aria-hidden="true">
            {text.length}/{CHAT_MAX_LENGTH}
          </span>
        ) : null}
      </div>
    </section>
  );
}
