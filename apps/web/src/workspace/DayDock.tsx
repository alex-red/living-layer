import { useMemo, useState } from 'react';
import { Button, IconButton } from '../ui/controls';
import {
  ASK_EXAMPLES,
  DAY_END,
  DAY_START,
  DAY_THINGS,
  DEMO_DAY,
  askRoom,
  clock,
  dayNudges,
  eventsUntil,
  type DayEvent,
  type RoomAnswer,
} from './demoDay';
import { REPLAY_SPEEDS, playReplay, setReplay, useReplay, useReplayClock } from './state/replay';
import './day.css';

const NUDGES = dayNudges();
/** How long a nudge stays on the phone, in minutes of the day. */
const NUDGE_SHOWN = 90;

function share(minute: number) {
  return `${((minute - DAY_START) / (DAY_END - DAY_START)) * 100}%`;
}

/**
 * The day replay under the canvas: a sample day of the room played back on
 * the iso twin, with each change and nudge on its timeline, and "Ask your
 * room" beside it. Every answer cites the events it rests on; a cited time
 * moves the replay there.
 */
export function DayDock() {
  const open = useReplay((r) => r.open);
  useReplayClock();
  return open ? <Dock /> : null;
}

function Dock() {
  const minute = useReplay((r) => Math.floor(r.minute));
  const playing = useReplay((r) => r.playing);
  const speed = useReplay((r) => r.speed);
  const last = eventsUntil(minute).at(-1);
  return (
    <section className="day-dock" aria-label="Day replay">
      <div className="day-bar">
        <IconButton
          label={playing ? 'Pause' : 'Play the day'}
          framed
          onClick={() => (playing ? setReplay({ playing: false }) : playReplay())}
        >
          {playing ? '❚❚' : '▶'}
        </IconButton>
        <span className="day-clock" aria-live="off">
          {clock(minute)}
        </span>
        <div className="day-track">
          {DEMO_DAY.map((e, i) => (
            <span
              key={i}
              className={`day-tick ${e.thing}`}
              style={{ left: share(e.at) }}
              title={`${clock(e.at)} · ${e.text}`}
            />
          ))}
          {NUDGES.map((n) => (
            <span
              key={n.id}
              className="day-tick nudge"
              style={{ left: share(n.at) }}
              title={`${clock(n.at)} · ${n.title}`}
            />
          ))}
          <input
            type="range"
            aria-label="Time of day"
            min={DAY_START}
            max={DAY_END}
            step={1}
            value={minute}
            onChange={(e) => setReplay({ minute: Number(e.target.value), playing: false })}
          />
        </div>
        <button
          type="button"
          className="day-speed"
          title="How fast the day plays"
          onClick={() =>
            setReplay({
              speed:
                REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(speed as never) + 1) % REPLAY_SPEEDS.length]!,
            })
          }
        >
          {speed}×
        </button>
        <span className="day-tag" title="A scripted day, until the things' own history is read">
          SAMPLE DAY
        </span>
        <IconButton
          label="Close the replay"
          onClick={() => setReplay({ open: false, playing: false })}
        >
          ×
        </IconButton>
      </div>
      <p className="day-last micro">
        {last ? (
          <>
            <Thing e={last} /> {clock(last.at)} · {last.text}
          </>
        ) : (
          'Nothing has happened yet today.'
        )}
      </p>
      <Ask minute={minute} />
    </section>
  );
}

function Thing({ e }: { e: DayEvent }) {
  return <span className={`day-dot ${e.thing}`} title={DAY_THINGS[e.thing]} aria-hidden="true" />;
}

/** "Ask your room": a question about the day so far, answered from its events. */
function Ask({ minute }: { minute: number }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<(RoomAnswer & { question: string }) | null>(null);
  const ask = (q: string) => {
    if (!q.trim()) return;
    setQuestion(q);
    setAnswer({ question: q, ...askRoom(q, minute) });
  };
  return (
    <div className="day-ask">
      <form
        className="day-ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          className="day-ask-input"
          aria-label="Ask your room"
          placeholder={`Ask your room about today, up to ${clock(minute)}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={!question.trim()}>
          Ask
        </Button>
      </form>
      {!answer && (
        <div className="day-examples" role="group" aria-label="Example questions">
          {ASK_EXAMPLES.map((q) => (
            <button key={q} type="button" className="day-example" onClick={() => ask(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      {answer && (
        <div className="day-answer" role="status">
          <p>{answer.text}</p>
          {answer.cites.length > 0 && (
            <div className="day-cites" role="group" aria-label="What it rests on">
              {answer.cites.map((e, i) => (
                <button
                  key={i}
                  type="button"
                  className="day-cite"
                  title="Show the room then"
                  onClick={() => setReplay({ minute: e.at, playing: false })}
                >
                  <Thing e={e} /> {clock(e.at)} {e.text}
                </button>
              ))}
            </div>
          )}
          <Button size="sm" variant="text" onClick={() => setAnswer(null)}>
            Ask something else
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The nudges Home Assistant would have pushed to the phone by this minute of
 * the day, as notifications over the room.
 */
export function DayNudges() {
  const open = useReplay((r) => r.open);
  const minute = useReplay((r) => Math.floor(r.minute));
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const shown = useMemo(
    () => NUDGES.filter((n) => n.at <= minute && minute - n.at < NUDGE_SHOWN),
    [minute],
  );
  if (!open) return null;
  const left = shown.filter((n) => !dismissed.has(n.id));
  if (!left.length) return null;
  const dismiss = (id: string) => setDismissed((d) => new Set(d).add(id));
  return (
    <div className="day-nudges" aria-label="Notifications" role="log">
      {left.map((n) => (
        <article key={n.id} className="day-nudge">
          <header>
            <span className="day-nudge-app">Home Assistant · Living Layer</span>
            <time>{clock(n.at)}</time>
          </header>
          <strong>{n.title}</strong>
          <p>{n.body}</p>
          <div className="day-nudge-actions">
            {n.action && (
              <button type="button" onClick={() => dismiss(n.id)}>
                {n.action}
              </button>
            )}
            <button type="button" onClick={() => dismiss(n.id)}>
              Dismiss
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

/** The chip over the room that opens the replay. */
export function DayChip() {
  const open = useReplay((r) => r.open);
  return (
    <div className="layer-chips iso day" role="group" aria-label="Your day">
      <button
        type="button"
        className="layer-chip"
        aria-pressed={open}
        title="Play back a sample day of the room, ask about it, and see the nudges it sends"
        onClick={() => setReplay({ open: !open, playing: false })}
      >
        ◷ Your day
      </button>
    </div>
  );
}
