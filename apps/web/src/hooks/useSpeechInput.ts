import { useCallback, useEffect, useRef, useState } from 'react';

/** Minimal Web Speech API typings (not in lib.dom for all TS versions). */
interface SpeechRecognitionResultLike {
  readonly length: number;
  [index: number]: { transcript: string };
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechCtor = new () => SpeechRecognitionLike;

export function getSpeechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type SpeechState = 'unsupported' | 'idle' | 'listening' | 'denied' | 'error';

/**
 * Voice-to-text for the Town Guide input. Nothing happens (and no permission is requested) until `start()`
 * is called from a click. Interim and final text go to `onText` so the player can review/edit before
 * sending: it never sends anything by itself.
 */
export function useSpeechInput(onText: (text: string) => void) {
  const supported = getSpeechCtor() !== null;
  const [state, setState] = useState<SpeechState>(supported ? 'idle' : 'unsupported');
  const [message, setMessage] = useState('');
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    setState((s) => (s === 'listening' ? 'idle' : s));
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechCtor();
    if (!Ctor) {
      setState('unsupported');
      return;
    }
    stop();
    const rec = new Ctor();
    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map((r) => r[0]?.transcript ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) onTextRef.current(text);
    };
    rec.onerror = (e) => {
      recRef.current = null;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setState('denied');
        setMessage("Microphone access is blocked. Allow it in your browser's site settings, or just type your question.");
      } else if (e.error === 'no-speech') {
        setState('idle');
        setMessage("I didn't hear anything. Try again or type your question.");
      } else if (e.error === 'aborted') {
        setState('idle');
      } else {
        setState('error');
        setMessage('Voice input had a problem. You can type your question instead.');
      }
    };
    rec.onend = () => {
      if (recRef.current === rec) {
        recRef.current = null;
        setState((s) => (s === 'listening' ? 'idle' : s));
        setMessage((m) => m || 'Check the text, then press Send.');
      }
    };
    recRef.current = rec;
    setMessage('');
    try {
      rec.start();
      setState('listening');
    } catch {
      recRef.current = null;
      setState('error');
      setMessage('Voice input could not start. You can type your question instead.');
    }
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return { supported, state, message, start, stop, toggle: () => (state === 'listening' ? stop() : start()) };
}
