import { describe, expect, it, mock } from 'bun:test';
import {
  DEMO_ASK_EXAMPLES,
  askExamples,
  answerAsk,
  dayOf,
  demoAsk,
  demoHistory,
  midnightOf,
  promoteBuiltIn,
  readAsk,
  zoneThingId,
  type AskHistory,
  type AskQuery,
  type DeskMemory,
  type EvidenceRun,
  type RoomAnswer,
} from '@livinglayer/domain';
import type { Fetcher } from '../apps/server/src/config.js';
import { createDesk } from '../apps/server/src/desk.js';
import { demoLamp } from '../apps/server/src/demo.js';
import { StatRunner } from '../apps/server/src/stats.js';
import { EvidenceStore } from '../apps/server/src/store.js';
import { tempDir, testApp } from './lib/app.js';

// Asking the room: a question read as one query, answered from stats' events.

/** A day the sample week is laid around, and a minute of it as ms. */
const DAY = midnightOf(new Date(2026, 10, 3, 12).getTime());
const at = (minute: number) => DAY + minute * 60_000;
const history = (minute: number): AskHistory => ({ ...demoHistory(at(minute)), watched: null });
/** A question read offline and answered as of a minute of the sample day. */
const ask = (question: string, minute: number, h = history(minute)) =>
  answerAsk(readAsk(demoAsk(question, h.things), h.things), h, at(minute));
const query = (q: Partial<AskQuery>): AskQuery => ({
  thing: 'mug',
  stat: 'lastUsed',
  measure: 'count',
  window: 'today',
  amount: null,
  compare: 'none',
  while: null,
  whileOn: null,
  clarify: null,
  ...q,
});
const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

describe('answerAsk', () => {
  it('counts the drinks in the last hour, as of the minute asked', () => {
    // The sample day's mug was used at 9:10 and 9:35, and before 9:00.
    const a = ask('How many times did I drink in the last hour?', 600);
    expect(a.text).toBe('You had 2 drinks from your desk mug in the last hour.');
    expect(a.cites.map((c) => clockOf(c.at))).toEqual(['09:10', '09:35']);
    expect(a.notes[0]).toContain('picked up and put back');
  });

  it('adds up screen time, with hourly bars that add up to it', () => {
    const a = ask('How long was my screen on today?', 1000);
    expect(a.text).toBe('Your screen was on for 8 h 10 min today.');
    expect(a.bars!.unit).toBe('minutes');
    expect(a.bars!.values.reduce((sum, v) => sum + v.value, 0)).toBe(8 * 60 + 10);
    // The night before the first session isn't drawn.
    expect(a.bars!.values[0]!.label).toBe('7');
  });

  it('finds the longest stretch without a drink between two uses', () => {
    const a = ask('What was my longest stretch without a drink?', 1000);
    expect(a.text).toBe(
      'Your longest stretch without a drink today was 3 h 20 min, from 12:45 to 16:05.',
    );
  });

  it('runs the stretch to now when the last use is the longest ago', () => {
    const a = answerAsk(query({ measure: 'longestGap' }), history(1260), at(1260));
    expect(a.text).toContain('from 16:05 to now');
  });

  it('counts a stretch running into the window for its time, not as a switching on', () => {
    // The lamp came on at 16:05.
    const h = history(980);
    const lamp = { thing: 'lamp', stat: 'power' as const, window: 'minutes' as const, amount: 10 };
    expect(answerAsk(query({ ...lamp, measure: 'count' }), h, at(980)).text).toBe(
      'The desk lamp didn’t come on in the last 10 min.',
    );
    expect(answerAsk(query({ ...lamp, measure: 'duration' }), h, at(980)).text).toBe(
      'The desk lamp was on for 10 min in the last 10 min.',
    );
  });

  it('compares with yesterday by this time, from the same events', () => {
    const a = ask('Did the cat nap more than yesterday?', 1000);
    const yesterday = answerAsk(
      query({ thing: 'cat-tree', stat: 'occupied', measure: 'duration' }),
      history(1000),
      at(1000 - 24 * 60),
    );
    expect(a.compared!.label).toBe('yesterday by this time');
    expect(yesterday.text).toContain(a.compared!.words);
    expect(a.text).toMatch(/That’s (more|less) than yesterday by this time/);
  });

  it('says which way a comparison went, as its words do', () => {
    const a = ask('Did the cat nap more than yesterday?', 1000);
    expect(a.text).toContain(`That’s ${a.compared!.trend} than`);
  });

  it('gives the one number to show large, in the answer’s own units', () => {
    expect(ask('How many times did I drink in the last hour?', 600).figure).toBe('2 drinks');
    expect(ask('How long was my screen on today?', 1000).figure).toBe('8 h 10 min');
    expect(ask('What was my longest stretch without a drink?', 1000).figure).toBe('3 h 20 min');
    expect(ask('What happened today?', 1000).figure).toBeNull();
  });

  it('draws a week as a bar a day, the quiet day lowest', () => {
    const a = ask('How long did I work at my desk this week?', 1000);
    expect(a.bars!.values).toHaveLength(7);
    const low = Math.min(...a.bars!.values.map((v) => v.value));
    expect(a.bars!.values.findIndex((v) => v.value === low)).toBe(3);
  });

  it('answers every question the dock offers without asking back', () => {
    for (const { question } of DEMO_ASK_EXAMPLES) {
      const a = ask(question, 1000);
      expect(a.clarify).toBeNull();
      expect(a.text.length).toBeGreaterThan(20);
    }
  });

  it('says how little of the window the camera watched', () => {
    const h: AskHistory = {
      ...history(600),
      watched: [{ from: at(570), to: at(600) }],
    };
    const a = answerAsk(query({ window: 'minutes', amount: 60 }), h, at(600));
    expect(a.notes).toContain('The camera watched for 30 min of those 1 h.');
  });

  it('asks back about a question on nothing it keeps', () => {
    const a = ask('What is the weather?', 1000);
    expect(a.clarify).toContain('Which one did you mean?');
    expect(a.query).toBeNull();
  });
});

describe('answerAsk across things', () => {
  it('adds up the lamp’s time only while the screen was off', () => {
    // Lamp 7:42–9:10 and 10:20–12:45; screen off before 7:45 and 12:30–13:15.
    const a = ask('Was the lamp on while I was away?', 1000);
    expect(a.query).toMatchObject({ thing: 'lamp', while: 'monitor', whileOn: false });
    expect(a.text).toBe('The desk lamp was on for 18 min today while your screen was off.');
    expect(a.cites.map((c) => clockOf(c.at))).toEqual(['07:42', '07:45', '12:30', '12:45']);
  });

  it('counts uses only while another thing was on', () => {
    const a = answerAsk(query({ while: 'monitor', whileOn: true }), history(600), at(600));
    // 8:20, 9:10 and 9:35 fall in the screen's 7:45 session; 7:42 doesn't.
    expect(a.text).toBe('You had 3 drinks from your desk mug today while your screen was on.');
  });

  it('adds up how long something was in a zone', () => {
    const a = ask('How long was the mug in the main zone today?', 1000);
    expect(a.query!.thing).toBe(zoneThingId('main'));
    expect(a.text).toBe('Something was in the main zone for 4 h 28 min today.');
    expect(a.cites.at(-1)!.text).toBe('Something came into the main zone');
  });
});

describe('answerAsk about food', () => {
  it('lists what to eat first by its use-by day', () => {
    expect(ask('What should I eat first?', 1000).text).toBe(
      'Eat the leftover chicken first: it goes off today. Then milk (tomorrow), spinach (in 4 days), eggs (in 12 days).',
    );
  });

  it('lists the food soonest first, with its days left', () => {
    expect(ask('What should I eat first?', 1000).foods!.map((f) => [f.label, f.days])).toEqual([
      ['Leftover chicken', 0],
      ['Milk', 1],
      ['Spinach', 4],
      ['Eggs', 12],
    ]);
  });

  it('says when one food goes off, citing when it was last taken out', () => {
    const a = ask('When does the milk go off?', 1000);
    expect(a.text).toBe('The milk goes off tomorrow.');
    expect(a.cites.map((c) => clockOf(c.at))).toEqual(['07:30']);
  });

  it('warns about food already past its day before what to eat first', () => {
    const h = history(1000);
    const a = answerAsk(
      query({ thing: null, stat: null, measure: 'useBy' }),
      h,
      at(1000) + 86_400_000,
    );
    expect(a.text).toStartWith(
      'The leftover chicken went off yesterday: check it before eating it.',
    );
  });
});

describe('answerAsk past the events’ 30 days', () => {
  it('adds up the day totals, a bar a week', () => {
    const h: AskHistory = {
      ...history(1000),
      totals: Array.from({ length: 60 }, (_, i) => ({
        day: dayOf(at(1000) - i * 86_400_000),
        thingId: 'monitor',
        key: 'power' as const,
        total: 3600,
      })),
    };
    const a = answerAsk(
      query({ thing: 'monitor', stat: 'power', measure: 'duration', window: 'days', amount: 60 }),
      h,
      at(1000),
    );
    expect(a.text).toBe('Your screen was on for 60 h in the last 60 days.');
    expect(a.bars!.values.reduce((sum, v) => sum + v.value, 0)).toBe(60 * 60);
    expect(a.notes.at(-1)).toContain('a bar is a week');
  });
});

describe('askExamples', () => {
  const things = history(1000).things;

  it('offers one question per thing, then what to eat first and the day so far', () => {
    const labels = askExamples(things, 9).map((e) => e.label);
    expect(labels.slice(0, 3)).toEqual(['Drinks today', 'Screen time', 'Computer mouse in use']);
    expect(labels.slice(-2)).toEqual(['Eat first', 'Today so far']);
    expect(labels).toHaveLength(9);
  });

  it('words each question so the room can answer it', () => {
    for (const e of askExamples(things, 20)) {
      const q = readAsk(demoAsk(e.question, things), things);
      expect(q.clarify).toBeNull();
      if (e.thing !== 'summary' && e.label !== 'Eat first') expect(q.thing).toBe(e.thing);
    }
  });

  it('offers nothing when no thing keeps a history', () => {
    expect(askExamples([])).toEqual([]);
  });
});

describe('readAsk', () => {
  const { things } = history(1000);

  it('asks back about a thing it doesn’t know', () => {
    expect(readAsk(query({ thing: 'kettle' }), things).clarify).toContain('my desk mug');
  });

  it('finds a thing by its label, and gives it its own stat', () => {
    expect(readAsk(query({ thing: 'Desk lamp', stat: 'lastUsed' }), things)).toMatchObject({
      thing: 'lamp',
      stat: 'power',
    });
  });

  it('counts uses when asked how long, since a use has no length', () => {
    expect(readAsk(query({ measure: 'duration' }), things).measure).toBe('count');
  });

  it('keeps a window’s amount in range', () => {
    expect(readAsk(query({ window: 'minutes', amount: null }), things).amount).toBe(60);
    expect(readAsk(query({ window: 'days', amount: 400 }), things).amount).toBe(90);
    expect(readAsk(query({ window: 'today', amount: 5 }), things).amount).toBeNull();
  });

  it('asks back when “while” names a thing that is never on or off', () => {
    expect(
      readAsk(query({ thing: 'lamp', stat: 'power', while: 'milk' }), things).clarify,
    ).toContain('only while something that is on or off');
  });

  it('reads “while” as while on unless it says off', () => {
    expect(readAsk(query({ while: 'Monitor' }), things)).toMatchObject({
      while: 'monitor',
      whileOn: true,
    });
  });

  it('asks back about the use-by of food that has none', () => {
    expect(readAsk(query({ measure: 'useBy' }), things).clarify).toContain('Set its use-by');
  });

  it('asks to switch a stat on when no thing keeps one', () => {
    expect(readAsk(query({}), []).clarify).toContain('Switch one on');
  });
});

describe('demoAsk', () => {
  const { things } = history(1000);

  it('reads the window a question names', () => {
    expect(demoAsk('drinks in the last 30 minutes', things)).toMatchObject({
      window: 'minutes',
      amount: 30,
    });
    expect(demoAsk('screen time in the past 3 hours', things)).toMatchObject({
      window: 'minutes',
      amount: 180,
    });
    expect(demoAsk('How long did I work this week?', things)).toMatchObject({
      thing: 'mouse',
      window: 'days',
      amount: 7,
    });
    expect(demoAsk('How many drinks yesterday?', things).window).toBe('yesterday');
  });

  it('reads a comparison', () => {
    expect(demoAsk('Is my screen on more than usual?', things).compare).toBe('average');
    expect(demoAsk('Did I drink more than yesterday?', things)).toMatchObject({
      window: 'today',
      compare: 'previous',
    });
  });
});

/** A fetcher answering every Spark call with `query`, as the ask call's JSON. */
function sparkAnswering(get: () => AskQuery) {
  return mock<Fetcher>(
    async () =>
      new Response(
        JSON.stringify({
          id: 'resp_ask',
          object: 'response',
          model: 'muse-spark-1.3',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(get()), annotations: [] }],
            },
          ],
          usage: { input_tokens: 400, output_tokens: 60, total_tokens: 460 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
}
const LIVE_ENV = { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' };

describe('POST /api/things/ask', () => {
  it('answers the demo from its sample week, as of the minute sent, as an ask run', async () => {
    const t = await testApp({ name: 'ask-demo' });
    const res = await t.post('things/ask', {
      question: 'How many times did I drink in the last hour?',
      at: at(600),
    });
    expect(res.statusCode).toBe(200);
    const run = res.json<EvidenceRun<RoomAnswer>>();
    expect(run.kind).toBe('ask');
    expect(run.output.text).toBe('You had 2 drinks from your desk mug in the last hour.');
    expect(t.fetcher).not.toHaveBeenCalled();
  });

  it('reads a live question with Spark and counts the stored events itself', async () => {
    const fetcher = sparkAnswering(() => spark);
    const t = await testApp({ name: 'ask-live', fetcher, env: LIVE_ENV });
    const live = (path: string, body: object) => t.post(path, { mode: 'live', ...body });
    const saved = (
      await live('fixtures/save', { fixture: promoteBuiltIn('fridge', 'milk')! })
    ).json<DeskMemory>();
    const id = saved.fixtures!.find((f) => f.builtIn === 'milk')!.id;
    await live('things/stats', { id, stats: [{ key: 'lastUsed' }] });
    await live('things/used', { id, at: Date.now() - 20 * 60_000 });
    const spark: AskQuery = query({ thing: id, window: 'minutes', amount: 60 });

    const run = (await live('things/ask', { question: 'Did I take the milk out lately?' })).json<
      EvidenceRun<RoomAnswer>
    >();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(run.output.text).toBe('The milk carton was taken out once in the last hour.');
    // Nothing watched the fridge: the answer says so.
    expect(run.output.notes).toContain(
      'The camera wasn’t watching then, so this may miss what happened.',
    );
  });

  it('asks Spark about food by its use-by day, though it keeps no stat', async () => {
    const fetcher = sparkAnswering(() => query({ thing: null, stat: null, measure: 'useBy' }));
    const t = await testApp({ name: 'ask-food', fetcher, env: LIVE_ENV });
    const expires = dayOf(Date.now() + 86_400_000);
    await t.post('fixtures/save', {
      mode: 'live',
      fixture: { ...promoteBuiltIn('fridge', 'milk')!, food: { expires } },
    });
    const run = (
      await t.post('things/ask', { mode: 'live', question: 'What should I eat first?' })
    ).json<EvidenceRun<RoomAnswer>>();
    expect(run.output.text).toBe('Eat the milk carton first: it goes off tomorrow.');
    // Spark was told when it goes off.
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)) as { input: unknown };
    expect(JSON.stringify(body.input)).toContain(`goes off ${expires}`);
  });
});

describe('zones as history', () => {
  it('keeps a motion zone filling and emptying as its occupied stat', async () => {
    const { app, post, config } = await testApp({ name: 'ask-zone' });
    await post('desk/rules/save', {
      rule: {
        label: 'Reading chair',
        objects: 'any',
        entityId: null,
        motion: { share: 0.02, quietS: 1 },
        actions: { onEnter: [], onLeave: [] },
        rect: { x: 0.5, y: 0.3, width: 0.1, height: 0.12 },
      },
    });
    await app.close();
    const store = new EvidenceStore(config.dataDir);
    const desk = createDesk(store, async () => demoLamp);
    const id = store.memory('demo').rules![0]!.id;
    await desk.motionZone('demo', id, 'started');
    await desk.motionZone('demo', id, 'stopped');
    const events = store.allStatEvents('demo', 0);
    expect(events.map((e) => [e.thingId, e.key, e.value])).toEqual([
      [zoneThingId(id), 'occupied', true],
      [zoneThingId(id), 'occupied', false],
    ]);
    store.close();
  });
});

describe('watched spans', () => {
  it('keeps when the camera watched, from start to stop', () => {
    const store = new EvidenceStore(tempDir('watch-spans'));
    let now = 1_000_000;
    const runner = new StatRunner({ mode: 'live', store, now: () => now });
    runner.setWatching(true);
    now += 10_000;
    runner.flush();
    expect(store.watchSpans('live', 0)).toEqual([{ from: 1_000_000, to: 1_010_000 }]);
    now += 10_000;
    runner.setWatching(false);
    expect(store.watchSpans('live', 0)).toEqual([{ from: 1_000_000, to: 1_020_000 }]);
  });
});
