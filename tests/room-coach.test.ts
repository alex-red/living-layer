import { describe, expect, it, mock } from 'bun:test';
import {
  COACH,
  actionEvents,
  coachDay,
  coachFacts,
  coachLine,
  dayOf,
  demoHistory,
  dueFacts,
  midnightOf,
  promoteBuiltIn,
  readCoachWords,
  type AskHistory,
  type AskThing,
  type CoachCheck,
  type CoachNudge,
  type CoachView,
  type CoachWords,
  type DeskMemory,
  type StatEvent,
} from '@livinglayer/domain';
import type { Fetcher } from '../apps/server/src/config.js';
import { testApp } from './lib/app.js';

// The room coach: facts worked out from the stats, a nudge worded from one.

const DAY = midnightOf(new Date(2026, 10, 3, 12).getTime());
const at = (minute: number) => DAY + minute * 60_000;
const history = (minute: number): AskHistory => ({ ...demoHistory(at(minute)), watched: null });
const facts = (minute: number) => coachFacts(history(minute), at(minute));
const fact = (minute: number, topic: string) => facts(minute).find((f) => f.topic === topic);

describe('coachFacts', () => {
  it('is due for a drink 20 minutes after the last, while someone is at the desk', () => {
    // The mug was used at 9:35 and the screen is on from 7:45 to 12:30.
    const drink = fact(9 * 60 + 55, 'drink')!;
    expect(drink.minutes).toBe(20);
    expect(drink.weight).toBe(1);
    expect(drink.text).toContain('the last at 9:35');
  });

  it('says nothing about a drink while nobody is at the desk', () => {
    // 18:20: the screen went off at 17:20 and the mouse is idle.
    expect(fact(18 * 60 + 20, 'drink')).toBeUndefined();
  });

  it('counts the screen’s unbroken stretch from when it came on', () => {
    expect(fact(10 * 60 + 45, 'screen')!.minutes).toBe(180);
  });

  it('notices a light left on once the screen goes off', () => {
    const things: AskThing[] = [
      { id: 'monitor', label: 'Monitor', stats: ['power'] },
      { id: 'lamp', label: 'Desk lamp', stats: ['power'] },
    ];
    const ev = (thingId: string, minute: number, value: boolean) => ({
      thingId,
      key: 'power' as const,
      at: at(minute),
      value,
      source: 'entity' as const,
      confidence: 1,
    });
    const h: AskHistory = {
      things,
      events: [ev('monitor', 540, true), ev('lamp', 570, true), ev('monitor', 600, false)],
      watched: null,
    };
    const lamp = coachFacts(h, at(620)).find((f) => f.topic === 'lampAway')!;
    expect(lamp.minutes).toBe(20);
    expect(lamp.weight).toBeGreaterThan(1);
  });

  it('flags food that goes off today', () => {
    expect(fact(600, 'food')!.text).toBe('Leftover chicken goes off today.');
  });
});

describe('dueFacts', () => {
  const nudged = (factId: string, minute: number): CoachNudge => ({
    id: `${factId}@${minute}`,
    at: at(minute),
    factId,
    topic: 'drink',
    title: '',
    body: '',
    by: 'offline',
    cites: [],
  });

  it('keeps quiet about a fact it nudged about within its cooldown', () => {
    const now = 11 * 60 + 25;
    const drink = fact(now, 'drink')!;
    const due = dueFacts(facts(now), [nudged(drink.id, now - 30)], at(now));
    expect(due.map((f) => f.id)).not.toContain(drink.id);
  });

  it('keeps quiet altogether just after any nudge', () => {
    const now = 11 * 60 + 25;
    expect(dueFacts(facts(now), [nudged('screen:monitor', now - 5)], at(now))).toEqual([]);
  });

  it('nudges anyway when asked to check now', () => {
    const now = 11 * 60 + 25;
    const drink = fact(now, 'drink')!;
    const due = dueFacts(facts(now), [nudged(drink.id, now - 5)], at(now), true);
    expect(due.map((f) => f.id)).toContain(drink.id);
  });
});

describe('coachLine', () => {
  it('says the time as a friend would', () => {
    const screen = fact(10 * 60 + 45, 'screen')!;
    const lines = [0, 1, 2, 3].map((seed) => coachLine(screen, at(645), seed).body);
    expect(lines.every((l) => l.includes('3 hours'))).toBe(true);
    expect(lines).toContain(
      'Hey, you’ve been staring at that monitor for like 3 hours, dude. It’s not going to blink first.',
    );
  });
});

describe('coachDay', () => {
  const day = () => coachDay(history(23 * 60), at(6 * 60 + 30), at(23 * 60));

  it('leaves at least the gap between nudges, and says the same on every replay', () => {
    const nudges = day();
    expect(nudges.length).toBeGreaterThan(5);
    for (let i = 1; i < nudges.length; i++)
      expect(nudges[i]!.at - nudges[i - 1]!.at).toBeGreaterThanOrEqual(COACH.gapMin * 60_000);
    expect(day()).toEqual(nudges);
  });

  it('nudges about drinks, the screen, the cat, food and the lamp over the sample day', () => {
    expect(new Set(day().map((n) => n.topic))).toEqual(
      new Set(['drink', 'screen', 'cat', 'food', 'lampAway']),
    );
  });

  it('keeps a snoozed topic quiet until the snooze ends', () => {
    const z = { topic: 'drink' as const, from: at(8 * 60), to: at(12 * 60) };
    const nudges = coachDay(history(23 * 60), at(6 * 60 + 30), at(23 * 60), [z]);
    const drinks = nudges.filter((n) => n.topic === 'drink').map((n) => n.at);
    expect(drinks.some((t) => t >= z.from && t < z.to)).toBe(false);
    expect(drinks.some((t) => t >= z.to)).toBe(true);
  });
});

describe('a nudge’s action', () => {
  const day = (h: AskHistory) => coachDay(h, at(6 * 60 + 30), at(23 * 60));
  const after = (h: AskHistory, extra: StatEvent[]): AskHistory => ({
    ...h,
    events: [...h.events, ...extra].sort((a, b) => a.at - b.at),
  });

  it('logs a sip, so the next drink nudge waits 20 minutes from it', () => {
    const h = history(23 * 60);
    const nudge = day(h).find((n) => n.topic === 'drink' && n.at > at(10 * 60))!;
    const acted = day(after(h, actionEvents(nudge, nudge.at)));
    const next = acted.find((n) => n.topic === 'drink' && n.at > nudge.at)!;
    expect(next.at - nudge.at).toBeGreaterThanOrEqual(COACH.thirstyMin * 60_000);
    // Up to the action, the day is the same.
    expect(acted.filter((n) => n.at <= nudge.at)).toEqual(day(h).filter((n) => n.at <= nudge.at));
  });

  it('takes a 5-minute break, so the screen’s stretch starts again after it', () => {
    const h = history(23 * 60);
    const nudge = day(h).find((n) => n.topic === 'screen')!;
    const [off, on] = actionEvents(nudge, nudge.at);
    expect(on!.at - off!.at).toBe(5 * 60_000);
    const screen = coachFacts(after(h, [off!, on!]), on!.at + 10 * 60_000).find(
      (f) => f.topic === 'screen',
    )!;
    expect(screen.minutes).toBe(10);
  });

  it('switches the lamp off, so it stops being left on', () => {
    const h = history(23 * 60);
    const nudge = day(h).find((n) => n.topic === 'lampAway')!;
    const events = actionEvents(nudge, nudge.at);
    expect(events.map((e) => [e.thingId, e.key, e.value])).toEqual([['lamp', 'power', false]]);
    const facts = coachFacts(after(h, events), events[0]!.at + 60_000);
    expect(facts.some((f) => f.topic === 'lampAway')).toBe(false);
  });
});

describe('readCoachWords', () => {
  const due = facts(10 * 60 + 45).filter((f) => f.weight >= 1);

  it('refuses a fact it wasn’t given', () => {
    expect(readCoachWords({ factId: 'screen:tv', title: 'Hi', body: 'Hello' }, due)).toBeNull();
  });

  it('clips a body past its length', () => {
    const words = readCoachWords(
      { factId: due[0]!.id, title: 'Blink', body: 'a'.repeat(400) },
      due,
    )!;
    expect(words.body).toHaveLength(220);
    expect(words.body.endsWith('…')).toBe(true);
  });
});

function sparkSaying(get: () => CoachWords | Error) {
  return mock<Fetcher>(async () => {
    const said = get();
    if (said instanceof Error) return new Response('{"error":"down"}', { status: 500 });
    return new Response(
      JSON.stringify({
        id: 'resp_coach',
        object: 'response',
        model: 'muse-spark-1.3',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(said), annotations: [] }],
          },
        ],
        usage: { input_tokens: 300, output_tokens: 40, total_tokens: 340 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
}
const LIVE_ENV = { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' };

/** A live room whose milk goes off today: a fact due with no camera needed. */
async function liveMilk(t: Awaited<ReturnType<typeof testApp>>) {
  const milk = { ...promoteBuiltIn('fridge', 'milk')!, food: { expires: dayOf(Date.now()) } };
  const saved = (await t.post('fixtures/save', { mode: 'live', fixture: milk })).json<DeskMemory>();
  return saved.fixtures!.find((f) => f.builtIn === 'milk')!.id;
}

describe('the room coach’s routes', () => {
  it('checks the demo as of the replay’s minute, worded offline', async () => {
    const t = await testApp({ name: 'coach-demo' });
    const check = (await t.post('coach/check', { at: at(10 * 60 + 45) })).json<CoachCheck>();
    expect(check.nudge!.by).toBe('offline');
    expect(check.nudge!.topic).toBe('screen');
    expect(t.fetcher).not.toHaveBeenCalled();
  });

  it('has Spark word a live nudge from the facts, and keeps it for the page', async () => {
    let factId = '';
    const fetcher = sparkSaying(() => ({ factId, title: 'Milk o’clock', body: 'Drink me.' }));
    const t = await testApp({ name: 'coach-live', fetcher, env: LIVE_ENV });
    factId = `food:${await liveMilk(t)}`;

    const check = (await t.post('coach/check', { mode: 'live' })).json<CoachCheck>();
    expect(check.nudge).toMatchObject({ by: 'spark', title: 'Milk o’clock', factId });
    const prompt = JSON.stringify(await fetcher.mock.calls[0]![1]!.body);
    expect(prompt).toContain('goes off today');
    const view = (await t.get('coach/live')).json<CoachView>();
    expect(view.nudges.map((n) => n.title)).toEqual(['Milk o’clock']);
  });

  it('words a live nudge offline when Spark fails, and says so', async () => {
    const fetcher = sparkSaying(() => new Error('down'));
    const t = await testApp({ name: 'coach-live-down', fetcher, env: LIVE_ENV });
    await liveMilk(t);
    const check = (await t.post('coach/check', { mode: 'live' })).json<CoachCheck>();
    expect(check.nudge!.by).toBe('offline');
    expect(check.note).toContain('offline');
  });

  it('makes no call when nothing is due', async () => {
    const fetcher = sparkSaying(() => ({ factId: null, title: '', body: '' }));
    const t = await testApp({ name: 'coach-live-quiet', fetcher, env: LIVE_ENV });
    const check = (await t.post('coach/check', { mode: 'live' })).json<CoachCheck>();
    expect(check.nudge).toBeNull();
    expect(check.quiet).toContain('Nothing to nag about');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('switches the live coach on and off', async () => {
    const t = await testApp({ name: 'coach-switch' });
    const on = (await t.post('coach/switch', { mode: 'live', on: true })).json<CoachView>();
    expect(on.on).toBe(true);
    expect(on.nextAt).toBeGreaterThan(Date.now());
    const off = (await t.post('coach/switch', { mode: 'live', on: false })).json<CoachView>();
    expect(off).toMatchObject({ on: false, nextAt: null });
  });
});
