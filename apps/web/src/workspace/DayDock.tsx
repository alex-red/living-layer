import { useMemo, useRef, useState } from 'react';
import {
  DEMO_ASK_EXAMPLES,
  DEMO_DAY,
  clockOf,
  midnightOf,
  type DayEvent,
  type RoomAnswer,
} from '@livinglayer/domain';
import { api } from '../api';
import { Button, IconButton } from '../ui/controls';
import { DAY_END, DAY_START, DAY_THINGS, clock, dayNudges, eventsUntil } from './demoDay';
import { useLabCalls } from './LabContext';
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

/** The dot a cited thing is drawn with, by its id in the demo. */
function dotOf(thingId: string): string {
  if (thingId === 'cat-tree') return 'cat';
  if (['milk', 'leftover-chicken', 'spinach'].includes(thingId)) return 'fridge';
  return ['mug', 'lamp', 'monitor', 'mouse'].includes(thingId) ? thingId : 'other';
}

/**
 * "Ask your room": a question about the room's history, read by Spark (live)
 * or offline (the demo, as of the replay's minute) and answered by the server
 * from the things' events. Every answer cites the events it rests on; in the
 * demo a cited time moves the replay there.
 */
function Ask({ minute }: { minute: number }) {
  const calls = useLabCalls();
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<(RoomAnswer & { question: string }) | null>(null);
  const asked = useRef(0);
  const demo = calls.mode() === 'demo';
  // The sample day is today: the replay's minute is a time today.
  const today = midnightOf(Date.now());
  const ask = async (q: string) => {
    if (!q.trim()) return;
    setQuestion(q);
    setError('');
    setAsking(true);
    const n = ++asked.current;
    try {
      const run = await api('things/ask', {
        mode: calls.mode(),
        question: q,
        ...(demo ? { at: today + minute * 60_000 } : {}),
      });
      if (n === asked.current) setAnswer({ question: q, ...run.output });
    } catch (e) {
      if (n === asked.current) setError(e instanceof Error ? e.message : 'The question failed.');
    } finally {
      if (n === asked.current) setAsking(false);
    }
  };
  return (
    <div className="day-ask">
      <form
        className="day-ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          className="day-ask-input"
          aria-label="Ask your room"
          placeholder={
            demo ? `Ask your room, as of ${clock(minute)}` : 'Ask your room about its history'
          }
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={!question.trim() || asking}>
          {asking ? 'Asking…' : 'Ask'}
        </Button>
      </form>
      {error && (
        <p className="day-ask-error micro" role="alert">
          {error}
        </p>
      )}
      {!answer && (
        <div className="day-examples" role="group" aria-label="Example questions">
          {DEMO_ASK_EXAMPLES.map((q) => (
            <button key={q} type="button" className="day-example" onClick={() => void ask(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      {answer && (
        <div className="day-answer" role="status">
          <p>{answer.text}</p>
          {answer.bars && <Bars bars={answer.bars} />}
          {answer.notes.map((n) => (
            <p key={n} className="day-note micro">
              {n}
            </p>
          ))}
          {answer.cites.length > 0 && (
            <div className="day-cites" role="group" aria-label="What it rests on">
              {answer.cites.map((c, i) => {
                const seek = demo && c.at >= today;
                const body = (
                  <>
                    <span className={`day-dot ${dotOf(c.thingId)}`} aria-hidden="true" />{' '}
                    {clockOf(c.at)} {c.text}
                  </>
                );
                return seek ? (
                  <button
                    key={i}
                    type="button"
                    className="day-cite"
                    title="Show the room then"
                    onClick={() =>
                      setReplay({ minute: Math.round((c.at - today) / 60_000), playing: false })
                    }
                  >
                    {body}
                  </button>
                ) : (
                  <span key={i} className="day-cite still">
                    {body}
                  </span>
                );
              })}
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

/** A count or a time per hour or per day, as bars. */
function Bars({ bars }: { bars: NonNullable<RoomAnswer['bars']> }) {
  const max = Math.max(...bars.values.map((v) => v.value), 1);
  const unit = bars.unit === 'times' ? '' : ' min';
  // Label every bar when they fit, else every third.
  const every = bars.values.length > 12 ? 3 : 1;
  return (
    <div
      className="day-bars"
      role="img"
      aria-label={bars.values.map((v) => `${v.label}: ${v.value}${unit}`).join(', ')}
    >
      {bars.values.map((v, i) => (
        <div key={v.from} className="day-bar-col" title={`${v.label}: ${v.value}${unit}`}>
          <span className="day-bar-track">
            <span className="day-bar-fill" style={{ height: `${(v.value / max) * 100}%` }} />
          </span>
          <span className="day-bar-label">{i % every === 0 ? v.label : ''}</span>
        </div>
      ))}
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
