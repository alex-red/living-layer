import { describe, expect, it } from 'bun:test';
import {
  COACH_ACTIONS,
  DEMO_LITTER_ASK_EXAMPLES,
  DEMO_LITTER_VISITS,
  LITTER,
  actionEvents,
  answerAsk,
  askThingsOf,
  coachDay,
  coachFacts,
  coachLine,
  coachNudge,
  demoAsk,
  demoHistory,
  isLitterBox,
  isWasteDrawer,
  litterNow,
  memberInput,
  midnightOf,
  promoteBuiltIn,
  readAsk,
  topicInRoom,
  type AskHistory,
  type DeskMemory,
  type StatEvent,
} from '@livinglayer/domain';
import { testApp } from './lib/app.js';

// The litter box room: Juniper's visits to the litter robot, its drawer, and what the coach says.

const DAY = midnightOf(new Date(2026, 10, 3, 12).getTime());
const at = (minute: number) => DAY + minute * 60_000;
const history = (minute: number, extra: StatEvent[] = []): AskHistory => {
  const h = demoHistory(at(minute));
  return { ...h, events: [...h.events, ...extra].sort((a, b) => a.at - b.at), watched: null };
};
const box = (h: AskHistory) => h.things.find((t) => t.id === 'litter-robot')!;
const now = (minute: number, extra: StatEvent[] = []) => {
  const h = history(minute, extra);
  return litterNow(h, box(h), at(minute))!;
};
const topics = (minute: number, extra: StatEvent[] = []) =>
  coachFacts(history(minute, extra), at(minute))
    .filter((f) => f.weight >= 1)
    .map((f) => f.topic);
const emptied = (minute: number): StatEvent => ({
  thingId: 'litter-drawer',
  key: 'lastUsed',
  at: at(minute),
  value: at(minute),
  source: 'person',
  confidence: 1,
});

describe('litter box names', () => {
  it('tells a litter box from its drawer, mat and bags', () => {
    expect(['Litter robot', 'Cat litter box'].every(isLitterBox)).toBe(true);
    expect(['Waste drawer', 'Litter mat', 'Litter bags'].some(isLitterBox)).toBe(false);
    expect(isWasteDrawer('Waste drawer')).toBe(true);
    expect(isWasteDrawer('Desk drawer')).toBe(false);
  });
});

describe('litterNow', () => {
  it('counts the visits so far today against a usual day by the same time', () => {
    const n = now(14 * 60);
    expect(n.cat).toBe('Juniper');
    expect(n.visits.map((v) => v.at)).toEqual(
      DEMO_LITTER_VISITS.filter(([m]) => m <= 14 * 60).map(([m]) => at(m)),
    );
    expect(n.usualByNow).toBe(2);
    expect(n.usualDay).toBeGreaterThan(3);
    expect(n.week).toHaveLength(7);
    expect(n.week.at(-1)!.visits).toBe(n.visits.length);
  });

  it('says how long the last visit lasted and how long ago the cat came out', () => {
    // Juniper went in at 15:05 for a minute.
    const n = now(15 * 60 + 30);
    expect(n.lastVisit).toEqual({ at: at(15 * 60 + 5), minutes: 1 });
    expect(n.sinceLast).toBe(24);
  });

  it('fills the drawer by the visits since it was last emptied, and empties it again', () => {
    const before = now(17 * 60);
    expect(before.drawer!.emptiedAt).not.toBeNull();
    expect(before.drawer!.share).toBeCloseTo(before.drawer!.visits / LITTER.drawerVisits);
    const after = now(17 * 60 + 30, [emptied(17 * 60 + 10)]);
    expect(after.drawer!.emptiedAt).toBe(at(17 * 60 + 10));
    expect(after.drawer!.share).toBe(0);
  });

  it('reads the cat’s weight from the box’s scale against the week’s first', () => {
    const n = now(12 * 60);
    expect(n.weight!.kg).toBeCloseTo(5.4, 1);
    expect(n.weight!.weekAgo).not.toBeNull();
  });
});

describe('the coach in the litter box room', () => {
  it('says nothing about the litter box on a usual morning', () => {
    expect(topics(9 * 60)).not.toContain('litterBusy');
    expect(topics(9 * 60)).not.toContain('drawer');
  });

  it('notices twice the usual visits by the early afternoon', () => {
    const busy = coachFacts(history(13 * 60 + 5), at(13 * 60 + 5)).find(
      (f) => f.topic === 'litterBusy',
    )!;
    expect(busy.text).toContain('Juniper has used the litter robot 4 times today');
    expect(busy.fill).toEqual({ count: '4', usual: '2' });
    expect(coachLine(busy, at(13 * 60 + 5)).body).toContain('4');
  });

  it('asks for the drawer to be emptied once it is 80% full, and stops once it is', () => {
    expect(topics(16 * 60 + 25)).toContain('drawer');
    const drawer = coachFacts(history(16 * 60 + 25), at(16 * 60 + 25)).find(
      (f) => f.topic === 'drawer',
    )!;
    const done = actionEvents(
      coachNudge(drawer, coachLine(drawer, at(16 * 60 + 25)), at(16 * 60 + 25), 'offline'),
      at(16 * 60 + 30),
    );
    expect(COACH_ACTIONS.drawer.label).toBe('Emptied it');
    expect(topics(16 * 60 + 40, done)).not.toContain('drawer');
  });

  it('asks to check on the cat after twelve hours without a visit', () => {
    // Today's visits after the first left out: nothing since 6:38.
    const h = history(19 * 60);
    const quiet = {
      ...h,
      events: h.events.filter(
        (e) => !(e.thingId === 'litter-robot' && e.at > at(7 * 60) && e.at <= at(19 * 60)),
      ),
    };
    const fact = coachFacts(quiet, at(19 * 60)).find((f) => f.topic === 'litterQuiet')!;
    expect(fact.weight).toBeGreaterThanOrEqual(1);
    expect(fact.text).toContain('since 6:35');
  });

  it('keeps a day of its own: the visits, then the drawer, and nothing of the desk', () => {
    const day = coachDay(history(23 * 60), at(6 * 60), at(23 * 60), [], 'litter');
    expect(day.map((n) => n.topic)).toEqual(['litterBusy', 'drawer']);
    const shared = coachDay(history(23 * 60), at(6 * 60), at(23 * 60), [], null);
    expect(shared.some((n) => ['litterBusy', 'drawer', 'litterQuiet'].includes(n.topic))).toBe(
      false,
    );
  });

  it('shows the litter box’s nudges over its own room alone', () => {
    expect(topicInRoom('drawer', 'litter')).toBe(true);
    expect(topicInRoom('drink', 'litter')).toBe(false);
    expect(topicInRoom('litterBusy', 'office')).toBe(false);
    expect(topicInRoom('litterBusy', 'fridge')).toBe(false);
  });
});

describe('asking about the litter box', () => {
  const ask = (question: string, minute = 15 * 60 + 30) => {
    const h = history(minute);
    return answerAsk(readAsk(demoAsk(question, h.things), h.things), h, at(minute));
  };

  it('answers every question the dock offers in the litter box room', () => {
    for (const e of DEMO_LITTER_ASK_EXAMPLES) expect(ask(e.question).clarify).toBeNull();
  });

  it('counts the cat’s visits, and compares them with a usual day', () => {
    expect(ask('How many times did Juniper use the litter robot today?').text).toBe(
      'Juniper used the litter robot 6 times today.',
    );
    expect(ask('Did Juniper use the litter robot more than usual today?').compared?.trend).toBe(
      'more',
    );
  });

  it('says when the drawer was last emptied', () => {
    expect(ask('When did I last empty the waste drawer?').text).toMatch(
      /^The waste drawer was last emptied at 19:30 on \w+, 5 days ago\.$/,
    );
  });

  it('counts visits, not minutes, in the day so far', () => {
    expect(ask('What happened today?').text).toContain('Juniper used the litter robot 6 times');
  });

  it('names a litter box’s cat from the cat in its room', () => {
    const robot = promoteBuiltIn('litter', 'litter-robot')!;
    const memory = {
      mode: 'live',
      lastDecision: null,
      fixtures: [
        { ...robot, id: 'robot', updatedAt: '2026-11-03T12:00:00Z' },
        {
          ...memberInput('cat', 'Pepper', { scene: 'litter', at: { x: 4, y: 3 } }),
          id: 'pepper',
          updatedAt: '2026-11-03T12:00:00Z',
        },
      ],
      thingStats: { robot: [{ key: 'occupied' }] },
    } as unknown as DeskMemory;
    expect(askThingsOf(memory).find((t) => t.id === 'robot')!.litter).toEqual({ cat: 'Pepper' });
  });
});

describe('the demo’s litter box room', () => {
  it('has its litter robot made a thing and Juniper, a tabby, beside the mat after a reset', async () => {
    const { app } = await testApp({ name: 'litter-room', appearance: async () => null });
    const res = await app.inject({ method: 'POST', url: '/api/desk/demo/reset' });
    const memory = res.json<DeskMemory>();
    const here = memory.fixtures!.filter((f) => f.scene === 'litter');
    expect(here.find((f) => f.builtIn === 'litter-robot')?.label).toBe('Litter robot');
    expect(here.find((f) => f.type === 'cat')).toMatchObject({
      label: 'Juniper',
      look: 'cat-tabby',
    });
    expect(memory.litterAt).toBeString();
  });
});
