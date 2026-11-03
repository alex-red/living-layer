/**
 * What a zone does when something enters it and when it empties: a short
 * list of steps each way. A step switches a light or a switch, waits, asks a
 * question (still occupied? is a thing inside? what time is it?) and takes
 * one branch, or repeats a few steps. Rules saved before steps existed read
 * as one switch on entering and, if asked, one off on emptying.
 */
import { z } from 'zod';
import { lightLookSchema, type LampResult, type LightLook } from './api.js';
import { entityIdSchema } from './fixture.js';
import type { PlacementRule } from './rules.js';

/** A question an `if` step asks when it is reached. */
export type ZoneCondition =
  /** Whether the zone has anything in it now: true for occupied, false for empty. */
  | { kind: 'occupied'; is: boolean }
  /** Whether one thing the zone counts is in it now. */
  | { kind: 'inside'; thingId: string; is: boolean }
  /** Whether the server's clock is between two times of day; `from` after `to` spans midnight. */
  | { kind: 'time'; from: string; to: string };

export type ZoneStep =
  | {
      kind: 'switch';
      /** A light or a switch; empty only in the main zone's old rule, for the main lamp. */
      entityId: string;
      to: 'on' | 'off';
      /** How a light looks when it comes on; unset keeps its own. */
      look?: LightLook;
    }
  | { kind: 'wait'; seconds: number }
  | { kind: 'if'; condition: ZoneCondition; then: ZoneStep[]; else: ZoneStep[] }
  | { kind: 'repeat'; times: number; steps: ZoneStep[] };

export interface ZoneActions {
  onEnter: ZoneStep[];
  onLeave: ZoneStep[];
}

/** The most steps a zone keeps, both ways and nested steps included. */
export const MAX_ZONE_STEPS = 32;
/** How deep `if` and `repeat` may nest: a step inside one inside one. */
export const MAX_ZONE_DEPTH = 3;
/** The longest single wait, in seconds: an hour. */
export const MAX_ZONE_WAIT_S = 3600;
export const MAX_ZONE_REPEAT = 20;

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('occupied'), is: z.boolean() }).strict(),
  z.object({ kind: z.literal('inside'), thingId: z.string().uuid(), is: z.boolean() }).strict(),
  z.object({ kind: z.literal('time'), from: timeOfDaySchema, to: timeOfDaySchema }).strict(),
]) satisfies z.ZodType<ZoneCondition>;

const stepSchema: z.ZodType<ZoneStep> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('switch'),
        entityId: entityIdSchema,
        to: z.enum(['on', 'off']),
        look: lightLookSchema.optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal('wait'), seconds: z.number().int().min(1).max(MAX_ZONE_WAIT_S) })
      .strict(),
    z
      .object({
        kind: z.literal('if'),
        condition: conditionSchema,
        then: z.array(stepSchema),
        else: z.array(stepSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal('repeat'),
        times: z.number().int().min(2).max(MAX_ZONE_REPEAT),
        steps: z.array(stepSchema),
      })
      .strict(),
  ]),
);

/** Steps within a step, for `if` and `repeat`. */
function childLists(step: ZoneStep): ZoneStep[][] {
  return step.kind === 'if' ? [step.then, step.else] : step.kind === 'repeat' ? [step.steps] : [];
}
/** How many steps a list holds, nested ones included. */
export function countSteps(steps: ZoneStep[]): number {
  return steps.reduce((n, s) => n + 1 + childLists(s).reduce((m, l) => m + countSteps(l), 0), 0);
}
/** How deep a list nests: 1 for plain steps, 2 with an `if` holding steps, … */
function stepDepth(steps: ZoneStep[]): number {
  return steps.reduce(
    (d, s) => Math.max(d, 1 + Math.max(0, ...childLists(s).map((l) => stepDepth(l)))),
    0,
  );
}
/** Every entity the steps switch, each once, in order. */
export function stepEntities(steps: ZoneStep[]): string[] {
  const out: string[] = [];
  const walk = (list: ZoneStep[]) => {
    for (const s of list) {
      if (s.kind === 'switch' && !out.includes(s.entityId)) out.push(s.entityId);
      childLists(s).forEach(walk);
    }
  };
  walk(steps);
  return out;
}
/** Every thing the steps' questions name. */
export function stepThings(steps: ZoneStep[]): string[] {
  const out: string[] = [];
  const walk = (list: ZoneStep[]) => {
    for (const s of list) {
      if (s.kind === 'if' && s.condition.kind === 'inside') out.push(s.condition.thingId);
      childLists(s).forEach(walk);
    }
  };
  walk(steps);
  return out;
}

export const zoneActionsSchema = z
  .object({ onEnter: z.array(stepSchema), onLeave: z.array(stepSchema) })
  .strict()
  .refine((a) => countSteps(a.onEnter) + countSteps(a.onLeave) <= MAX_ZONE_STEPS, {
    message: `A zone keeps up to ${MAX_ZONE_STEPS} steps.`,
  })
  .refine((a) => Math.max(stepDepth(a.onEnter), stepDepth(a.onLeave)) <= MAX_ZONE_DEPTH, {
    message: `Steps nest at most ${MAX_ZONE_DEPTH} deep.`,
  }) satisfies z.ZodType<ZoneActions>;

/**
 * What a rule does each way. A rule saved with steps has them; an older one
 * switches its entity on entering and, with `offWhenEmpty`, off on emptying.
 * The main zone's empty entity stands for the main lamp.
 */
export function ruleActions(
  rule: Pick<PlacementRule, 'actions' | 'entityId' | 'offWhenEmpty' | 'look'>,
): ZoneActions {
  if (rule.actions) return rule.actions;
  if (rule.entityId === null) return { onEnter: [], onLeave: [] };
  const entityId = rule.entityId;
  return {
    onEnter: [{ kind: 'switch', entityId, to: 'on', ...(rule.look ? { look: rule.look } : {}) }],
    onLeave: rule.offWhenEmpty ? [{ kind: 'switch', entityId, to: 'off' }] : [],
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
/** A wait in words: "30 s", "5 min", "1 h 30 min". */
function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600)
    return seconds % 60
      ? `${Math.floor(seconds / 60)} min ${seconds % 60} s`
      : `${seconds / 60} min`;
  const min = Math.round((seconds % 3600) / 60);
  return `${Math.floor(seconds / 3600)} h${min ? ` ${min} min` : ''}`;
}
/** A question in words, with a thing's name looked up. */
function conditionWords(c: ZoneCondition, thingName: (id: string) => string): string {
  if (c.kind === 'occupied') return c.is ? 'still occupied' : 'empty';
  if (c.kind === 'inside') return `the ${thingName(c.thingId)} is ${c.is ? '' : 'not '}inside`;
  return `it is between ${c.from} and ${c.to}`;
}
/** Steps in a line: "turn on light.desk, wait 5 min, then if empty: turn off light.desk". */
export function stepsWords(
  steps: ZoneStep[],
  thingName: (id: string) => string = () => 'thing',
): string {
  return steps
    .map((s) => {
      switch (s.kind) {
        case 'switch':
          return `turn ${s.to} ${s.entityId || 'the main lamp'}`;
        case 'wait':
          return `wait ${waitWords(s.seconds)}`;
        case 'if': {
          const then = stepsWords(s.then, thingName) || 'nothing';
          const otherwise = s.else.length ? `, otherwise ${stepsWords(s.else, thingName)}` : '';
          return `if ${conditionWords(s.condition, thingName)}: ${then}${otherwise}`;
        }
        case 'repeat':
          return `${plural(s.times, 'time')}: ${stepsWords(s.steps, thingName)}`;
      }
    })
    .join(', ');
}

/** Whether a time of day ("HH:MM") falls in [from, to), spanning midnight when from > to. */
export function inTimeWindow(now: Date, from: string, to: string): boolean {
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const m = now.getHours() * 60 + now.getMinutes();
  const a = minutes(from);
  const b = minutes(to);
  if (a === b) return true;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** What running steps can do; the server switches, the tests pretend. */
interface StepRunner {
  switch: (step: Extract<ZoneStep, { kind: 'switch' }>) => Promise<LampResult>;
  /** Asked when an `if` is reached, against the zone as it is then. */
  holds: (condition: ZoneCondition) => boolean;
  /** Resolves after the wait, or early once `signal` aborts. */
  sleep: (ms: number) => Promise<void>;
  /** Aborted when a newer trigger of the same zone takes over. */
  signal: AbortSignal;
  /** One line per step done, for the zone's last check. */
  log: (line: string) => void;
}
/** How a run of steps went: what it switched, and why it stopped. */
interface StepsOutcome {
  lamps: LampResult[];
  failed: { code: string; message: string } | null;
  cancelled: boolean;
}
/**
 * Run steps in order. A switch that fails stops the run, as it would leave
 * the rest acting on a device in an unknown state; a newer trigger of the
 * zone stops it between steps or during a wait.
 */
export async function runSteps(steps: ZoneStep[], run: StepRunner): Promise<StepsOutcome> {
  const out: StepsOutcome = { lamps: [], failed: null, cancelled: false };
  const go = async (list: ZoneStep[]): Promise<boolean> => {
    for (const s of list) {
      if (run.signal.aborted) {
        out.cancelled = true;
        return false;
      }
      switch (s.kind) {
        case 'switch': {
          try {
            const lamp = await run.switch(s);
            out.lamps.push(lamp);
            run.log(
              `Turned ${s.to} ${lamp.entityId}${lamp.stateConfirmed ? '' : ' (unconfirmed)'}.`,
            );
          } catch (error) {
            const e = error as { code?: unknown; message?: unknown };
            out.failed = {
              code: typeof e.code === 'string' ? e.code : 'switch_failed',
              message: typeof e.message === 'string' ? e.message : 'The switch failed.',
            };
            run.log(
              `Couldn’t turn ${s.to} ${s.entityId || 'the main lamp'}: ${out.failed.message}`,
            );
            return false;
          }
          break;
        }
        case 'wait':
          run.log(`Waiting ${waitWords(s.seconds)}…`);
          await run.sleep(s.seconds * 1000);
          break;
        case 'if': {
          const yes = run.holds(s.condition);
          run.log(
            `Asked whether ${conditionWords(s.condition, () => 'thing')}: ${yes ? 'yes' : 'no'}.`,
          );
          if (!(await go(yes ? s.then : s.else))) return false;
          break;
        }
        case 'repeat':
          for (let i = 0; i < s.times; i++) if (!(await go(s.steps))) return false;
          break;
      }
    }
    return true;
  };
  await go(steps);
  if (run.signal.aborted) out.cancelled = true;
  return out;
}
