import { describe, expect, it, mock } from 'bun:test';
import {
  DEMO_ASK_EXAMPLES,
  answerAsk,
  demoAsk,
  demoHistory,
  midnightOf,
  promoteBuiltIn,
  readAsk,
  type AskHistory,
  type AskQuery,
  type DeskMemory,
  type EvidenceRun,
  type RoomAnswer,
} from '@livinglayer/domain';
import type { Fetcher } from '../apps/server/src/config.js';
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

  it('draws a week as a bar a day, the quiet day lowest', () => {
    const a = ask('How long did I work at my desk this week?', 1000);
    expect(a.bars!.values).toHaveLength(7);
    const low = Math.min(...a.bars!.values.map((v) => v.value));
    expect(a.bars!.values.findIndex((v) => v.value === low)).toBe(3);
  });

  it('answers every question the dock offers without asking back', () => {
    for (const q of DEMO_ASK_EXAMPLES) {
      const a = ask(q, 1000);
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
    expect(readAsk(query({ window: 'days', amount: 400 }), things).amount).toBe(30);
    expect(readAsk(query({ window: 'today', amount: 5 }), things).amount).toBeNull();
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
    const fetcher = mock<Fetcher>(
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
                content: [{ type: 'output_text', text: JSON.stringify(spark), annotations: [] }],
              },
            ],
            usage: { input_tokens: 400, output_tokens: 60, total_tokens: 460 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const t = await testApp({
      name: 'ask-live',
      fetcher,
      env: { MODEL_API_KEY: 'test-key', META_LIVE_ENABLED: 'true' },
    });
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
