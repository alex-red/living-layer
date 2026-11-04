import type { FastifyInstance } from 'fastify';
import {
  COACH,
  askThingsOf,
  coachCheckBodySchema,
  coachFacts,
  coachLine,
  coachNudge,
  coachQuerySchema,
  coachSwitchBodySchema,
  demoHistory,
  dueFacts,
  quietWords,
  readCoachWords,
  type AskHistory,
  type CoachCheck,
  type CoachNudge,
  type CoachView,
  type Mode,
} from '@livinglayer/domain';
import { parseInput } from './errors.js';
import type { MetaAdapter } from './meta.js';
import { requestSignal } from './request-signal.js';
import type { Runner } from './runs.js';
import type { StatRunner } from './stats.js';
import type { EvidenceStore } from './store.js';

const MINUTE = 60_000;
/** The stored setting that keeps the live coach looking. */
const SETTING = 'room_coach';

/**
 * The room coach: live, every `COACH.everyMin` minutes while switched on, it
 * works out what the room's stats say and, when something is due, has Spark
 * word a nudge (one cheap call; none when nothing is due). The demo looks only
 * when asked, from its sample week, and words nudges offline.
 */
export class RoomCoach {
  private nudges: CoachNudge[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextAt: number | null = null;
  private looking: Promise<CoachCheck> | null = null;
  constructor(
    private deps: {
      store: EvidenceStore;
      meta: MetaAdapter;
      run: Runner;
      runners: Record<Mode, StatRunner>;
      now?: () => number;
      log?: (message: string) => void;
    },
  ) {}
  private get now() {
    return this.deps.now?.() ?? Date.now();
  }
  get on() {
    return this.deps.store.setting(SETTING) === 'on';
  }
  /** Look every few minutes while on: called once at startup, and by the switch. */
  start() {
    this.stop();
    if (!this.on) return;
    this.nextAt = this.now + COACH.everyMin * MINUTE;
    this.timer = setInterval(() => void this.tick(), COACH.everyMin * MINUTE);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextAt = null;
  }
  setOn(on: boolean) {
    if (on) this.deps.store.setSetting(SETTING, 'on');
    else this.deps.store.deleteSetting(SETTING);
    this.start();
  }
  /** One scheduled look; a failure is logged, and the next look comes all the same. */
  async tick() {
    this.nextAt = this.now + COACH.everyMin * MINUTE;
    try {
      await this.check('live');
    } catch (e) {
      this.deps.log?.(`The room coach couldn't look: ${e instanceof Error ? e.message : e}`);
    }
  }
  view(mode: Mode): CoachView {
    return {
      on: mode === 'live' ? this.on : true,
      everyMin: COACH.everyMin,
      nextAt: mode === 'live' ? this.nextAt : null,
      nudges: mode === 'live' ? this.nudges : [],
    };
  }
  /** What the coach reads: the demo's sample week, or the last day of the live room's stats. */
  private history(mode: Mode, now: number): AskHistory {
    if (mode === 'demo') return { ...demoHistory(now), watched: null };
    const runner = this.deps.runners.live;
    runner.flush();
    const events = this.deps.store
      .allStatEvents('live', now - 86_400_000)
      // While the camera isn't watching, what it last saw isn't now: leave its stats out.
      .filter((e) => e.at <= now && (runner.isWatching || e.source !== 'camera'));
    return { things: askThingsOf(this.deps.store.memory('live')), events, watched: null };
  }
  /**
   * Look now. `force` (the page's "Check now") nudges about the most due fact
   * even if it nudged about it lately; a scheduled look keeps to the waits.
   * Live, the nudge is kept for the page and its Spark call recorded as a run.
   */
  check(mode: Mode, o: { at?: number; force?: boolean; signal?: AbortSignal } = {}) {
    // Two looks at once would both nudge: the second waits for the first.
    const look = (this.looking ?? Promise.resolve()).then(() => this.look(mode, o));
    this.looking = look.catch(() => null as never);
    return look;
  }
  private async look(
    mode: Mode,
    { at, force = false, signal }: { at?: number; force?: boolean; signal?: AbortSignal },
  ): Promise<CoachCheck> {
    const now = at ?? this.now;
    const facts = coachFacts(this.history(mode, now), now);
    const due = dueFacts(facts, mode === 'live' ? this.nudges : [], now, force);
    const top = due[0];
    if (!top) return { at: now, nudge: null, quiet: quietWords(facts), note: null, facts };
    let nudge: CoachNudge;
    let note: string | null = null;
    if (mode === 'demo') nudge = coachNudge(top, coachLine(top, now), now, 'offline');
    else {
      try {
        const run = await this.deps.run(
          'coach',
          mode,
          async () => {
            const said = await this.deps.meta.coach(due.slice(0, 3), now, signal);
            const words = readCoachWords(said.output, due);
            const { output: _, ...provider } = said;
            return {
              ...provider,
              output: words
                ? {
                    at: now,
                    nudge: coachNudge(words.fact, words, now, 'spark'),
                    quiet: null,
                    note: null,
                    facts,
                  }
                : { at: now, nudge: null, quiet: 'Spark chose to keep quiet.', note: null, facts },
            };
          },
          signal,
        );
        if (!run.output.nudge) return run.output;
        nudge = run.output.nudge;
      } catch (e) {
        // No Spark (off, over the spend limit, down): the offline lines still nudge.
        nudge = coachNudge(top, coachLine(top, now, this.nudges.length), now, 'offline');
        note = `Spark couldn’t word it (${e instanceof Error ? e.message : 'it failed'}), so this one is offline.`;
      }
      this.nudges = [...this.nudges, nudge].slice(-COACH.kept);
    }
    return { at: now, nudge, quiet: null, note, facts };
  }
}

/** The coach's routes: what it said lately, look now, and switch it on or off (live). */
export async function coachRoutes(app: FastifyInstance, { coach }: { coach: RoomCoach }) {
  app.get('/:mode', async (request) => {
    const { mode } = parseInput(coachQuerySchema, request.params);
    return coach.view(mode);
  });
  app.post('/check', async (request) => {
    const { mode, at } = parseInput(coachCheckBodySchema, request.body);
    return coach.check(mode, {
      ...(at !== undefined ? { at } : {}),
      force: true,
      signal: requestSignal(request),
    });
  });
  app.post('/switch', async (request) => {
    const { on } = parseInput(coachSwitchBodySchema, request.body);
    coach.setOn(on);
    return coach.view('live');
  });
}
