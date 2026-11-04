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
import { IconButton } from '../ui/controls';
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
  const [cited, setCited] = useState<number[]>([]);
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
          {cited.map((m) => (
            <span key={m} className="day-tick cited" style={{ left: share(m) }} />
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
      <Ask minute={minute} onCited={setCited} />
    </section>
  );
}

function Thing({ e }: { e: DayEvent }) {
  return <span className={`day-dot ${e.thing}`} title={DAY_THINGS[e.thing]} aria-hidden="true" />;
}

/** The dot a thing is drawn with, by its id in the demo. */
function dotOf(thingId: string): string {
  if (thingId === 'cat-tree') return 'cat';
  if (thingId.startsWith('zone:')) return 'zone';
  if (['milk', 'leftover-chicken', 'spinach', 'eggs'].includes(thingId)) return 'fridge';
  return ['mug', 'lamp', 'monitor', 'mouse', 'summary'].includes(thingId) ? thingId : 'other';
}

type Asked = RoomAnswer & { question: string; asOf: number };

/**
 * "Ask your room": a question about the room's history, read by Spark (live)
 * or offline (the demo, as of the replay's minute) and answered by the server
 * from the things' events. The answer leads with its number, then the
 * sentence, a chart and what it rests on; the times it cites are marked on
 * the day's track, and in the demo a cited time moves the replay there.
 */
function Ask({ minute, onCited }: { minute: number; onCited: (minutes: number[]) => void }) {
  const calls = useLabCalls();
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState('');
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<Asked | null>(null);
  const asked = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const demo = calls.mode() === 'demo';
  // The sample day is today: the replay's minute is a time today.
  const today = midnightOf(Date.now());
  const show = (a: Asked | null) => {
    setAnswer(a);
    onCited(
      a ? a.cites.filter((c) => c.at >= today).map((c) => Math.round((c.at - today) / 60_000)) : [],
    );
  };
  const ask = async (q: string) => {
    if (!q.trim()) return;
    setQuestion(q);
    setError('');
    setAsking(q);
    const n = ++asked.current;
    try {
      const run = await api('things/ask', {
        mode: calls.mode(),
        question: q,
        ...(demo ? { at: today + minute * 60_000 } : {}),
      });
      if (n === asked.current) show({ question: q, asOf: minute, ...run.output });
    } catch (e) {
      if (n === asked.current) setError(e instanceof Error ? e.message : 'The question failed.');
    } finally {
      if (n === asked.current) setAsking('');
    }
  };
  const clear = () => {
    show(null);
    setQuestion('');
    input.current?.focus();
  };
  const others = DEMO_ASK_EXAMPLES.filter((e) => e.question !== answer?.question);
  return (
    <div className="ask">
      <form
        className="ask-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <span className="ask-spark" aria-hidden="true">
          ✦
        </span>
        <input
          ref={input}
          className="ask-input"
          aria-label="Ask your room"
          placeholder={
            demo
              ? `Ask your room about its day, as of ${clock(minute)}`
              : 'Ask your room about its history'
          }
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          type="submit"
          className="ask-send"
          aria-label="Ask"
          title="Ask (Enter)"
          disabled={!question.trim() || Boolean(asking)}
        >
          {asking ? <span className="ask-spinner" aria-hidden="true" /> : '↑'}
        </button>
      </form>
      {error && (
        <p className="ask-error" role="alert">
          {error}
        </p>
      )}
      {asking ? (
        <div className="ask-card loading" aria-busy="true">
          <p className="ask-q">{asking}</p>
          <span className="ask-shimmer wide" />
          <span className="ask-shimmer" />
        </div>
      ) : answer ? (
        <Answer
          answer={answer}
          demo={demo}
          today={today}
          minute={minute}
          onClear={clear}
          onAgain={() => void ask(answer.question)}
        />
      ) : (
        <Suggestions items={DEMO_ASK_EXAMPLES} onAsk={(q) => void ask(q)} />
      )}
      {answer && !asking && (
        <Suggestions
          items={others.slice(0, 4)}
          lead={answer.clarify ? 'Try' : 'Also ask'}
          onAsk={(q) => void ask(q)}
        />
      )}
    </div>
  );
}

function Suggestions({
  items,
  lead,
  onAsk,
}: {
  items: readonly (typeof DEMO_ASK_EXAMPLES)[number][];
  lead?: string;
  onAsk: (question: string) => void;
}) {
  return (
    <div className="ask-suggestions" role="group" aria-label={lead ?? 'Example questions'}>
      {lead && <span className="ask-lead-label">{lead}</span>}
      {items.map((e) => (
        <button
          key={e.question}
          type="button"
          className="ask-chip"
          title={e.question}
          onClick={() => onAsk(e.question)}
        >
          <span className={`day-dot ${dotOf(e.thing)}`} aria-hidden="true" />
          {e.label}
        </button>
      ))}
    </div>
  );
}

const TREND_ARROW = { more: '▲', less: '▼', same: '=' } as const;

function Answer({
  answer,
  demo,
  today,
  minute,
  onClear,
  onAgain,
}: {
  answer: Asked;
  demo: boolean;
  today: number;
  minute: number;
  onClear: () => void;
  onAgain: () => void;
}) {
  const { compared, figure, bars, foods, cites, notes } = answer;
  // The replay has moved on since the answer: it may no longer hold.
  const stale = demo && Math.abs(minute - answer.asOf) >= 5;
  return (
    <article className={`ask-card${answer.clarify ? ' clarify' : ''}`} role="status">
      <header className="ask-head">
        <p className="ask-q">{answer.question}</p>
        {demo && <span className="ask-asof">as of {clock(answer.asOf)}</span>}
        <IconButton label="Clear the answer" size="sm" onClick={onClear}>
          ×
        </IconButton>
      </header>
      <div className={`ask-body${bars ? ' charted' : ''}`}>
        <div className="ask-main">
          {figure && <Figure value={figure} />}
          {compared && (
            <span
              className={`ask-trend ${compared.trend}`}
              title={`${compared.label}: ${compared.words}`}
            >
              <span aria-hidden="true">{TREND_ARROW[compared.trend]}</span>{' '}
              {compared.trend === 'same' ? 'About the same as' : `${cap(compared.trend)} than`}{' '}
              {compared.label} · {compared.words}
            </span>
          )}
          <p className={figure ? 'ask-text' : 'ask-text big'}>
            {answer.clarify && (
              <span className="ask-back" aria-hidden="true">
                ?
              </span>
            )}
            {answer.text}
          </p>
          {foods && <Foods foods={foods} />}
        </div>
        {bars && <Bars bars={bars} />}
      </div>
      {cites.length > 0 && (
        <div className="ask-cites" role="group" aria-label="What it rests on">
          <span className="ask-lead-label">Seen</span>
          {cites.map((c, i) => {
            const seek = demo && c.at >= today;
            const body = (
              <>
                <span className={`day-dot ${dotOf(c.thingId)}`} aria-hidden="true" />
                <time>{clockOf(c.at)}</time> {c.text}
              </>
            );
            return seek ? (
              <button
                key={i}
                type="button"
                className="ask-cite"
                title="Show the room then"
                onClick={() =>
                  setReplay({ minute: Math.round((c.at - today) / 60_000), playing: false })
                }
              >
                {body}
              </button>
            ) : (
              <span key={i} className="ask-cite still">
                {body}
              </span>
            );
          })}
        </div>
      )}
      {notes.length > 0 && (
        <ul className="ask-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {stale && (
        <button type="button" className="ask-again" onClick={onAgain}>
          ↻ The day is at {clock(minute)} now · ask again
        </button>
      )}
    </article>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "5 h 3 min" with its numbers large and its units small. */
function Figure({ value }: { value: string }) {
  return (
    <p className="ask-figure">
      {value.split(/(\d+(?::\d+)?)/).map((part, i) =>
        part === '' ? null : /\d/.test(part) ? (
          <span key={i} className="num">
            {part}
          </span>
        ) : (
          <span key={i} className="unit">
            {part}
          </span>
        ),
      )}
    </p>
  );
}

/** Food by its use-by day, soonest first. */
function Foods({ foods }: { foods: NonNullable<RoomAnswer['foods']> }) {
  const when = (d: number) =>
    d < 0 ? 'gone off' : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `${d} days`;
  const tone = (d: number) => (d < 0 ? 'gone' : d <= 1 ? 'soon' : 'fine');
  return (
    <ol className="ask-foods">
      {foods.map((f, i) => (
        <li key={f.thingId} className={tone(f.days)}>
          <span className="ask-rank">{i + 1}</span>
          <span className="ask-food">{f.label}</span>
          <span className="ask-days">{when(f.days)}</span>
        </li>
      ))}
    </ol>
  );
}

/** A count or a time per hour or per day, as bars: the highest one labelled. */
function Bars({ bars }: { bars: NonNullable<RoomAnswer['bars']> }) {
  const max = Math.max(...bars.values.map((v) => v.value), 1);
  const top = bars.values.findIndex((v) => v.value === max);
  const unit = bars.unit === 'times' ? '' : ' min';
  // Label every bar when they fit, else every third.
  const every = bars.values.length > 12 ? 3 : 1;
  return (
    <div
      className="ask-bars"
      role="img"
      aria-label={bars.values.map((v) => `${v.label}: ${v.value}${unit}`).join(', ')}
    >
      {bars.values.map((v, i) => (
        <div
          key={v.from}
          className={`ask-col${i === top ? ' top' : ''}`}
          title={`${v.label}: ${v.value}${unit}`}
        >
          <span className="ask-bar-value">{i === top ? `${v.value}${unit}` : ''}</span>
          <span className="ask-bar-track">
            <span className="ask-bar-fill" style={{ height: `${(v.value / max) * 100}%` }} />
          </span>
          <span className="ask-bar-label">{i % every === 0 || i === top ? v.label : ''}</span>
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
