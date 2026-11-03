import { useState } from 'react';
import { Button } from '../ui/controls';

/** One AI edit of the draft, newest last: what was asked and what Spark says it changed. */
export interface AiEditStep {
  prompt: string;
  note: string;
}

/** Requests to start from, as the placeholder can't show more than one. */
const SUGGESTIONS = ['make it red', 'make it taller', 'add a lid', 'round the edges'];

/**
 * Edit the model in words: the request goes to Spark with the draft as it is,
 * and the answer comes back as the new draft, unsaved, with what changed.
 * Each edit can be undone here; Save model keeps them all, Revert drops them.
 */
export function AiEdit({
  label,
  busy,
  blocked,
  steps,
  onAsk,
  onUndo,
}: {
  label: string;
  busy: boolean;
  /** Why it can't be asked now, when it can't. */
  blocked: string | null;
  steps: AiEditStep[];
  /** Resolves once the draft holds the answer; true when it does. */
  onAsk: (prompt: string) => Promise<boolean>;
  onUndo: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [asking, setAsking] = useState(false);
  const off = busy || asking || Boolean(blocked);
  async function ask(text: string) {
    const said = text.trim();
    if (!said || off) return;
    setAsking(true);
    try {
      if (await onAsk(said)) setPrompt('');
    } finally {
      setAsking(false);
    }
  }
  return (
    <section className="ai-edit" aria-label="Edit with AI">
      <form
        className="ai-edit-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(prompt);
        }}
      >
        <span className="tiny">EDIT WITH AI</span>
        <textarea
          aria-label={`What to change about the ${label.toLowerCase()}`}
          rows={1}
          maxLength={400}
          value={prompt}
          disabled={off}
          placeholder={
            steps.length
              ? 'Keep going: “a bit smaller”, “now make the lid white”'
              : '“Make the handle thicker and red”, “add a lid”, “print LAB on the front”'
          }
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(prompt);
            }
          }}
        />
        <Button type="submit" variant="primary" disabled={off || !prompt.trim()}>
          {asking ? 'Editing…' : 'Edit'}
        </Button>
      </form>
      {blocked ? (
        <p className="micro">{blocked}</p>
      ) : steps.length === 0 ? (
        <div className="ai-edit-suggest" role="group" aria-label="Suggested edits">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={off} onClick={() => void ask(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : (
        <ol className="ai-edit-steps" aria-label="AI edits to this draft">
          {steps.map((s, i) => (
            <li key={i}>
              <span className="ai-edit-asked">“{s.prompt}”</span> {s.note}
              {i === steps.length - 1 && (
                <Button variant="text" size="sm" disabled={off} onClick={onUndo}>
                  Undo
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
