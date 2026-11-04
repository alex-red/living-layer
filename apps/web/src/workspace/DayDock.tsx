import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  DEMO_ASK_EXAMPLES,
  DEMO_DAY,
  DEMO_HOME_ASK_EXAMPLES,
  askExamples,
  askThingsOf,
  type AskExample,
  type AskKind,
  COACH,
  COACH_ACTIONS,
  COACH_SNOOZE_MIN,
  type CoachNudge,
  type CoachTopic,
  clockOf,
  midnightOf,
  type DayEvent,
  type RoomAnswer,
  householdEvents,
  topicInRoom,
} from '@livinglayer/domain';
import { api } from '../api';
import { IconButton } from '../ui/controls';
import { DAY_END, DAY_START, DAY_THINGS, clock, dayNudges, eventsUntil } from './demoDay';
import { useDesk, useLabCalls, useView } from './LabContext';
import {
  actOnNudge,
  checkCoach,
  demoCoachDay,
  dismissNudge,
  snoozeNudge,
  switchCoach,
  takeAskNext,
  useCoach,
  useLiveCoach,
} from './state/coach';
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
  const { mode } = useView();
  useReplayClock();
  if (!open) return null;
  return mode === 'live' ? <LiveDock /> : <Dock />;
}

const noCites = () => {};

/**
 * Live, the dock is only "Ask your room", about the room's own history: no
 * sample day to play back, and examples from the things that keep stats.
 */
function LiveDock() {
  const { memory } = useDesk();
  const examples = useMemo(() => askExamples(memory ? askThingsOf(memory) : []), [memory]);
  return (
    <section className="day-dock" aria-label="Ask your room">
      <div className="day-bar">
        <span className="ask-title">
          <span className="ask-spark" aria-hidden="true">
            ✦
          </span>{' '}
          Ask your room
        </span>
        <span className="ask-sub micro">
          From what your camera and devices kept · one small model call a question
        </span>
        <IconButton label="Close" onClick={() => setReplay({ open: false })}>
          ×
        </IconButton>
      </div>
      <CoachBar minute={0} />
      <Ask minute={0} examples={examples} onCited={noCites} />
    </section>
  );
}

/** The household's day, as the dock shows it in the Home room. */
const HOME_DAY = householdEvents();

function Dock() {
  const minute = useReplay((r) => Math.floor(r.minute));
  const playing = useReplay((r) => r.playing);
  const speed = useReplay((r) => r.speed);
  // In the Home room the day is the household's: who came home, sat down, fell asleep.
  const home = useView().workScene === 'home';
  const last = home ? null : eventsUntil(minute).at(-1);
  const lastHome = home ? HOME_DAY.filter((e) => e.at <= minute).at(-1) : null;
  const [cited, setCited] = useState<number[]>([]);
  const extra = useCoach((c) => c.extra);
  const snoozes = useCoach((c) => c.snoozes);
  // The room coach's nudges over the sample day, as minutes of it, for the track.
  const coachTicks = useMemo(() => {
    const day = midnightOf(Date.now());
    return demoCoachDay(extra, snoozes).map((n) => ({
      id: n.id,
      title: n.title,
      minute: Math.round((n.at - day) / 60_000),
    }));
  }, [extra, snoozes]);
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
          {home
            ? HOME_DAY.map((e, i) => (
                <span
                  key={i}
                  className="day-tick member"
                  style={{ left: share(e.at) }}
                  title={`${clock(e.at)} · ${e.text}`}
                />
              ))
            : DEMO_DAY.map((e, i) => (
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
          {coachTicks.map((n) => (
            <span
              key={n.id}
              className="day-tick coach"
              style={{ left: share(n.minute) }}
              title={`${clock(n.minute)} · Room coach: ${n.title}`}
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
        {lastHome ? (
          <>
            <span className="day-dot member" title="The household" aria-hidden="true" />{' '}
            {clock(lastHome.at)} · {lastHome.text}
          </>
        ) : last ? (
          <>
            <Thing e={last} /> {clock(last.at)} · {last.text}
          </>
        ) : (
          'Nothing has happened yet today.'
        )}
      </p>
      <CoachBar minute={minute} />
      <Ask
        minute={minute}
        examples={home ? DEMO_HOME_ASK_EXAMPLES : DEMO_ASK_EXAMPLES}
        onCited={setCited}
      />
    </section>
  );
}

function Thing({ e }: { e: DayEvent }) {
  return <span className={`day-dot ${e.thing}`} title={DAY_THINGS[e.thing]} aria-hidden="true" />;
}

/** The dot a kind of thing is drawn with: the same colours as the day's track. */
const KIND_DOT: Record<AskKind, string> = {
  drink: 'mug',
  food: 'fridge',
  screen: 'monitor',
  cat: 'cat',
  pointer: 'mouse',
  light: 'lamp',
  zone: 'zone',
  member: 'member',
  other: 'other',
  summary: 'summary',
};

type Asked = RoomAnswer & { question: string; asOf: number };

/**
 * "Ask your room": a question about the room's history, read by Spark (live)
 * or offline (the demo, as of the replay's minute) and answered by the server
 * from the things' events. The answer leads with its number, then the
 * sentence, a chart and what it rests on; the times it cites are marked on
 * the day's track, and in the demo a cited time moves the replay there.
 */
function Ask({
  minute,
  examples,
  onCited,
}: {
  minute: number;
  examples: readonly AskExample[];
  onCited: (minutes: number[]) => void;
}) {
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
  // A nudge's button may ask a question ("What do I eat?"): put it as if typed.
  const askNext = useCoach((c) => c.askNext);
  const askFromNudge = useEffectEvent(() => {
    const q = takeAskNext();
    if (q) void ask(q);
  });
  useEffect(() => {
    if (askNext) askFromNudge();
  }, [askNext]);
  const clear = () => {
    show(null);
    setQuestion('');
    input.current?.focus();
  };
  const others = examples.filter((e) => e.question !== answer?.question);
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
      ) : examples.length ? (
        <Suggestions items={examples} onAsk={(q) => void ask(q)} />
      ) : (
        <p className="ask-empty">
          Nothing here keeps a history yet. Switch a stat on in a thing’s card, or add a zone, and
          its history can be asked about.
        </p>
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
  items: readonly AskExample[];
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
          <span className={`day-dot ${KIND_DOT[e.kind]}`} aria-hidden="true" />
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
                <span className={`day-dot ${KIND_DOT[c.kind] ?? 'other'}`} aria-hidden="true" />
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

/** A coach nudge's dot, by topic. */
const TOPIC_DOT: Record<CoachTopic, string> = {
  drink: 'mug',
  screen: 'monitor',
  late: 'monitor',
  lampAway: 'lamp',
  cat: 'cat',
  food: 'fridge',
  alone: 'member',
};
/** How long a live coach nudge stays over the room, ms. */
const LIVE_SHOWN_MS = 30 * 60_000;
/** How long a coach nudge stays over the replay, in minutes of the day. */
const COACH_SHOWN = 30;
/** Notifications shown at once, newest first. */
const SHOWN_AT_ONCE = 3;

interface Shown {
  id: string;
  at: number;
  time: string;
  coach: boolean;
  title: string;
  body: string;
  action?: string | undefined;
  dot?: string;
  bySpark?: boolean;
  /** A room coach's nudge, whose buttons act in the demo. */
  nudge?: CoachNudge;
}

/**
 * Notifications over the room, as a phone shows them. In the demo, while the
 * day plays: the nudges Home Assistant would have pushed and the room coach's,
 * each as its minute passes, and any "Check now" brought. Live: what the room
 * coach said in the last half hour.
 */
export function DayNudges() {
  const replaying = useReplay((r) => r.open);
  const { mode, workScene } = useView();
  const minute = useReplay((r) => Math.floor(r.minute));
  const live = useCoach((c) => c.live);
  const checked = useCoach((c) => c.checked);
  const dismissed = useCoach((c) => c.dismissed);
  const acted = useCoach((c) => c.acted);
  const extra = useCoach((c) => c.extra);
  const snoozes = useCoach((c) => c.snoozes);
  useLiveCoach(mode === 'live');
  const today = midnightOf(Date.now());
  const shown = useMemo((): Shown[] => {
    const coachCard = (n: CoachNudge, time: string): Shown => ({
      id: n.id,
      at: n.at,
      time,
      coach: true,
      title: n.title,
      body: n.body,
      dot: TOPIC_DOT[n.topic],
      bySpark: n.by === 'spark',
      nudge: n,
    });
    if (mode === 'live')
      return (live?.nudges ?? [])
        .filter((n) => Date.now() - n.at < LIVE_SHOWN_MS)
        .map((n) => coachCard(n, clockOf(n.at)));
    if (!replaying) return [];
    const now = today + minute * 60_000;
    const recent = (at: number) => at <= now && now - at < NUDGE_SHOWN * 60_000;
    // The Home room's nudges are the household's; the desk's stay with the office.
    const here = (n: CoachNudge) => topicInRoom(n.topic, workScene);
    return [
      ...NUDGES.filter((n) => workScene !== 'home' && recent(today + n.at * 60_000)).map(
        (n): Shown => ({
          id: n.id,
          at: today + n.at * 60_000,
          time: clock(n.at),
          coach: false,
          title: n.title,
          body: n.body,
          action: n.action,
        }),
      ),
      ...demoCoachDay(extra, snoozes)
        .filter((n) => here(n) && n.at <= now && now - n.at < COACH_SHOWN * 60_000)
        .map((n) => coachCard(n, clockOf(n.at))),
      ...checked.filter(here).map((n) => coachCard(n, clockOf(n.at))),
    ];
  }, [mode, live, replaying, minute, today, checked, extra, snoozes, workScene]);
  const left = shown
    .filter((n) => !dismissed.includes(n.id))
    .sort((a, b) => b.at - a.at)
    .slice(0, SHOWN_AT_ONCE);
  if (!left.length) return null;
  const demo = mode === 'demo';
  const now = today + minute * 60_000;
  return (
    <div className="day-nudges" aria-label="Notifications" role="log">
      {left.map((n) => (
        <article key={n.id} className={`day-nudge${n.coach ? ' coach' : ''}`}>
          <header>
            <span className="day-nudge-app">
              {n.coach ? (
                <>
                  <span className="ask-spark" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Room coach{n.bySpark ? ' · Spark' : ''}
                </>
              ) : (
                'Home Assistant · Living Layer'
              )}
            </span>
            <time>{n.time}</time>
          </header>
          <strong>
            {n.dot && <span className={`day-dot ${n.dot}`} aria-hidden="true" />} {n.title}
          </strong>
          <p>{n.body}</p>
          {n.nudge && acted[n.id] && (
            <p className="day-nudge-done" role="status">
              ✓ {acted[n.id]}
            </p>
          )}
          <div className="day-nudge-actions">
            {n.nudge && demo && !acted[n.id] ? (
              <>
                <button type="button" className="primary" onClick={() => actOnNudge(n.nudge!, now)}>
                  {COACH_ACTIONS[n.nudge.topic].label}
                </button>
                <button
                  type="button"
                  title={`Keep quiet about this for ${COACH_SNOOZE_MIN} min`}
                  onClick={() => snoozeNudge(n.nudge!, now)}
                >
                  Snooze
                </button>
              </>
            ) : (
              !n.nudge &&
              n.action && (
                <button type="button" onClick={() => dismissNudge(n.id)}>
                  {n.action}
                </button>
              )
            )}
            <button type="button" onClick={() => dismissNudge(n.id)}>
              {n.nudge && acted[n.id] ? 'Done' : 'Dismiss'}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

/**
 * The room coach's strip in the dock: what it does, "Check now", and live,
 * the switch and when it looks next. A quiet answer shows beside it.
 */
function CoachBar({ minute }: { minute: number }) {
  const { mode } = useView();
  const live = useCoach((c) => c.live);
  const checking = useCoach((c) => c.checking);
  const said = useCoach((c) => c.said);
  const demo = mode === 'demo';
  const on = demo || Boolean(live?.on);
  const next =
    !demo && live?.nextAt ? Math.max(1, Math.ceil((live.nextAt - Date.now()) / 60_000)) : null;
  return (
    <div className="coach-bar">
      <span className="coach-name">
        <span className="ask-spark" aria-hidden="true">
          ✦
        </span>{' '}
        Room coach
      </span>
      {!demo && (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className="coach-switch"
          title={
            on
              ? 'Stop the coach looking every few minutes'
              : 'Have the coach look every few minutes: one small Spark call when something is due'
          }
          onClick={() => void switchCoach(!on)}
        >
          <span aria-hidden="true" />
        </button>
      )}
      <span className="coach-about micro">
        {demo
          ? `Looks every ${COACH.everyMin} min as the day plays, and nudges when something’s due`
          : on
            ? `Looks every ${COACH.everyMin} min${next ? ` · next in ${next} min` : ''} · one small Spark call when something’s due`
            : `Off · switch it on to look every ${COACH.everyMin} min`}
      </span>
      {said && <span className="coach-said micro">{said}</span>}
      <button
        type="button"
        className="ask-chip coach-check"
        disabled={checking}
        title={demo ? `Look at the room as of ${clock(minute)}` : 'Look at the room now'}
        onClick={() =>
          void checkCoach(mode, demo ? midnightOf(Date.now()) + minute * 60_000 : undefined)
        }
      >
        {checking ? 'Looking…' : 'Check now'}
      </button>
    </div>
  );
}

/** The chip over the room that opens the replay. */
export function DayChip() {
  const open = useReplay((r) => r.open);
  const { mode } = useView();
  const live = mode === 'live';
  return (
    <div className="layer-chips iso day" role="group" aria-label={live ? 'Ask' : 'Your day'}>
      <button
        type="button"
        className="layer-chip"
        aria-pressed={open}
        title={
          live
            ? 'Ask your room about its history: what your things did, from the stats they keep'
            : 'Play back a sample day of the room, ask about it, and see the nudges it sends'
        }
        onClick={() => setReplay({ open: !open, playing: false })}
      >
        {live ? '✦ Ask your room' : '◷ Your day'}
      </button>
    </div>
  );
}
