import { useGame } from '../state';

export default function InteractionPrompt() {
  const prompt = useGame((s) => s.nearPrompt);
  if (!prompt) return <div className="prompt-slot" aria-live="polite" />;
  const m = /^press\s+(\S+)\s+to\s+(.+)$/i.exec(prompt.trim());
  return (
    <div className="prompt-slot" aria-live="polite">
      <div className="panel glass prompt" role="status">
        {m ? (
          <>
            <kbd>{m[1]}</kbd>
            <span>{m[2]}</span>
          </>
        ) : (
          <span>{prompt}</span>
        )}
      </div>
    </div>
  );
}
