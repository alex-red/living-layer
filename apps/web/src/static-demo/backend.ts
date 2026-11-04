import type { z } from 'zod';
import {
  answerAsk,
  coachCheckBodySchema,
  coachFacts,
  coachLine,
  coachNudge,
  COACH,
  coachSwitchBodySchema,
  defaultFixtureStates,
  demoAsk,
  demoHistory,
  DEMO_LIGHTS,
  DEMO_SWITCHES,
  deskRestoreBodySchema,
  dueFacts,
  fixtureEntities,
  fixtureEntity,
  fixtureProblem,
  fixturesAwayBodySchema,
  fixturesControlBodySchema,
  fixturesDeleteBodySchema,
  fixturesLayerBodySchema,
  fixturesReleaseBodySchema,
  fixturesSaveBodySchema,
  fixturesSeatBodySchema,
  fixturesStateBodySchema,
  fixturesUndismissBodySchema,
  followSurfaces,
  isDismissed,
  isMember,
  isoSurface,
  lampBodySchema,
  lightSources,
  linkedFixtures,
  MAX_DISMISSED,
  MAX_FIXTURES,
  modeIdSchema,
  placedFixtures,
  quietWords,
  readAsk,
  sceneSaveBodySchema,
  seatPerson,
  settingsSpendLimitBodySchema,
  settingsTrackingAiBodySchema,
  settleFixtures,
  standUp,
  thingsAskBodySchema,
  topicInRoom,
  uniqueParts,
  withNewModel,
  withoutThings,
  type CoachCheck,
  type CoachView,
  type DeskMemory,
  type EvidenceRun,
  type Fixture,
  type FixtureState,
  type IsoScene,
  type LabStatus,
  type LampResult,
  type Mode,
  type RunKind,
  type SavedItem,
} from '@livinglayer/domain';

/**
 * What the static demo starts from: the lab server's own answers on a fresh
 * demo, saved by `bun run static-demo` (`scripts/static-demo.ts`). `get` is by
 * path under `/api/` with its query; `post` is a read-only POST by path and mode.
 */
export interface StaticSeed {
  /** When the answers were saved, in ms. */
  at: number;
  get: Record<string, unknown>;
  post: Record<string, unknown>;
}

interface StaticReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The answer to anything that needs the lab's server: a scan, a model call, a camera, Live. */
const NEEDS_SERVER =
  'This needs the lab’s own server, which the web demo doesn’t have. Run Living Layer locally (bun run dev) to try it.';

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const needsServer = () => new Refused('static_demo', NEEDS_SERVER, 409);
const unknownFixture = () =>
  new Refused('fixture_unknown', 'That fixture is not in this desk memory.', 404);

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new Refused('invalid_request', parsed.error.issues[0]?.message ?? 'Bad request.', 400);
  return parsed.data;
}

/**
 * The lab server's demo, in the page: the answers a fresh demo gives, and the
 * demo's own actions (asking the room, the coach, switching its virtual lights,
 * a thing's state, who sits where and who is out, the layout, undo, reset) done
 * here on its desk memory with the domain's functions, as the server does them
 * (`apps/server/src/fixture/`, `coach.ts`, `stats.ts`). Anything that needs
 * the server answers 409 `static_demo`. Nothing is kept past the page.
 */
export function staticBackend(
  seed: StaticSeed,
  { now = () => Date.now(), newId = () => crypto.randomUUID() } = {},
) {
  const seeded = (mode: Mode) =>
    structuredClone((seed.get[`desk/${mode}`] ?? { mode, lastDecision: null }) as DeskMemory);
  const desks: Record<Mode, DeskMemory> = { demo: seeded('demo'), live: seeded('live') };
  const versions: Record<Mode, number> = { demo: 0, live: 0 };
  const runs = structuredClone((seed.get.runs ?? []) as EvidenceRun[]);
  let runsVersion = 0;
  const status = structuredClone(seed.get.status) as LabStatus | undefined;

  const save = (memory: DeskMemory) => {
    desks[memory.mode] = memory;
    versions[memory.mode]++;
    return memory;
  };
  /** A copy of the demo's desk to change; live is the server's alone. */
  const demoDesk = (mode: Mode) => {
    if (mode !== 'demo') throw needsServer();
    return structuredClone(desks.demo);
  };
  const fixtureIn = (memory: DeskMemory, id: string) => {
    const f = memory.fixtures?.find((x) => x.id === id);
    if (!f) throw unknownFixture();
    return f;
  };
  const record = <K extends RunKind>(kind: K, mode: Mode, output: unknown): EvidenceRun => {
    const run = {
      id: newId(),
      kind,
      mode,
      createdAt: new Date(now()).toISOString(),
      promptVersion: `${kind}-v1`,
      assets: [],
      model: null,
      requestId: null,
      usage: null,
      status: 'completed',
      durationMs: 0,
      output,
    } as unknown as EvidenceRun;
    runs.unshift(run);
    runsVersion++;
    return run;
  };
  const tagged = (body: unknown, tag: string, asked: string | undefined): StaticReply =>
    asked === tag
      ? { status: 304, body: null, headers: { ETag: tag } }
      : { status: 200, body, headers: { ETag: tag } };

  /** The demo's virtual adapter (`demoLampFor`): any demo light or switch, confirmed, no request sent. */
  const lamp = (entityId: string, action: 'on' | 'off'): LampResult => {
    if (![...DEMO_LIGHTS, ...DEMO_SWITCHES].includes(entityId))
      throw new Refused(
        'lamp_unknown',
        'That entity is not one of the demo lights or switches.',
        409,
      );
    return {
      entityId,
      action,
      accepted: true,
      stateConfirmed: true,
      physicalEffectVerified: false,
      state: action,
      desired: {},
      explanation:
        'Virtual adapter only. No Home Assistant request was sent and no physical effect was verified.',
    };
  };

  let coachOn = false;
  const coachView = (mode: Mode): CoachView => ({
    on: mode === 'live' ? coachOn : true,
    everyMin: COACH.everyMin,
    nextAt: null,
    nudges: [],
  });

  const gets: [RegExp, (m: RegExpMatchArray, ifNoneMatch?: string) => StaticReply][] = [
    [
      /^desk\/(demo|live)$/,
      ([, mode], asked) =>
        tagged(desks[mode as Mode], `"desk-${mode}-${versions[mode as Mode]}"`, asked),
    ],
    [/^runs$/, (_, asked) => tagged(runs, `"runs-${runsVersion}"`, asked)],
    [/^status$/, () => ({ status: 200, body: status })],
    [/^jobs$/, () => ({ status: 200, body: [] })],
    [/^coach\/(demo|live)$/, ([, mode]) => ({ status: 200, body: coachView(mode as Mode) })],
  ];

  const posts: Record<string, (body: unknown) => unknown> = {
    'things/ask': (body) => {
      const { mode, question, at } = parse(thingsAskBodySchema, body);
      if (mode !== 'demo') throw needsServer();
      const when = at ?? now();
      const history = { ...demoHistory(when), watched: null };
      const query = readAsk(demoAsk(question, history.things), history.things);
      return record('ask', mode, answerAsk(query, history, when));
    },
    'coach/check': (body): CoachCheck => {
      const { mode, at, scene } = parse(coachCheckBodySchema, body);
      if (mode !== 'demo') throw needsServer();
      const when = at ?? now();
      const facts = coachFacts({ ...demoHistory(when), watched: null }, when).filter(
        (f) => scene === undefined || topicInRoom(f.topic, scene),
      );
      const top = dueFacts(facts, [], when, true)[0];
      if (!top) return { at: when, nudge: null, quiet: quietWords(facts), note: null, facts };
      const nudge = coachNudge(top, coachLine(top, when), when, 'offline');
      return { at: when, nudge, quiet: null, note: null, facts };
    },
    'coach/switch': (body) => {
      coachOn = parse(coachSwitchBodySchema, body).on;
      return coachView('live');
    },
    'settings/tracking-ai': (body) => {
      const { on } = parse(settingsTrackingAiBodySchema, body);
      if (status) status.tracking.ai = on;
      return { on };
    },
    'settings/spend-limit': (body) => {
      const { usd } = parse(settingsSpendLimitBodySchema, body);
      const limit =
        usd === null ? (status?.meta.defaultSpendLimit ?? 0) : Math.round(usd * 100) / 100;
      if (status) status.meta.spendLimit = limit;
      return { spendLimit: limit };
    },
    /** The by-hand switch (`lamp.ts`): the main light on, unless it names another and which way. */
    lamp: (body) => {
      const { mode, entityId, action } = parse(lampBodySchema, body);
      if (mode !== 'demo') throw needsServer();
      return record('lamp', mode, lamp(entityId ?? DEMO_LIGHTS[0]!, action));
    },
    'nodes/list': (body) =>
      seed.post[`nodes/list:${(body as { mode?: Mode }).mode ?? 'demo'}`] ?? { nodes: [] },
    'streams/stats': () => ({}),

    'desk/restore': (body) => {
      const { mode, memory } = parse(deskRestoreBodySchema, body);
      demoDesk(mode);
      const next = memory as unknown as DeskMemory;
      if (next.mode !== mode)
        throw new Refused('restore_mode', `This save is for ${next.mode} mode, not ${mode}.`, 400);
      if (next.surface && !isoSurface(next.surface.scene, next.surface.surfaceId, next.scene))
        throw new Refused('restore_surface', 'The saved pin names a surface the scene lacks.', 400);
      return save({ ...next, lastDecision: next.lastDecision ?? null });
    },
    'desk/demo/reset': () => save(seeded('demo')),
    'desk/demo/household': () => {
      const memory = demoDesk('demo');
      if (memory.fixtures?.some((f) => f.scene === 'home' && isMember(f))) return memory;
      const household = seeded('demo').fixtures?.filter((f) => f.scene === 'home') ?? [];
      const kept = (memory.fixtures ?? []).filter((f) => !household.some((h) => h.id === f.id));
      return save({ ...memory, fixtures: [...kept, ...household] });
    },
    'scene/save': (body) => {
      const { mode, scene } = parse(sceneSaveBodySchema, body);
      const memory = demoDesk(mode);
      const before = memory.scene ?? null;
      const next = (scene ?? null) as IsoScene | null;
      // The server fits a calibrated custom room's camera again when its size changes; that needs it.
      if (
        memory.camera?.scene === 'custom' &&
        before &&
        next &&
        (before.grid.w !== next.grid.w || before.grid.d !== next.grid.d)
      )
        throw needsServer();
      memory.scene = next;
      if (memory.fixtures)
        memory.fixtures = settleFixtures(followSurfaces(memory.fixtures, before, next), next);
      if (
        memory.surface?.scene === 'custom' &&
        !isoSurface('custom', memory.surface.surfaceId, memory.scene)
      )
        memory.surface = null;
      return save(memory);
    },

    'fixtures/control': (body) => {
      const { mode, fixtureId, entityId, part, action } = parse(fixturesControlBodySchema, body);
      const memory = demoDesk(mode);
      let entity = entityId ?? null;
      if (fixtureId) {
        const fixture = fixtureIn(memory, fixtureId);
        if (part) {
          const light = fixture.lights?.find((l) => l.part === part);
          if (!light)
            throw new Refused(
              'fixture_control',
              `That light source of the ${fixture.label} switches nothing.`,
              400,
            );
          entity = light.entityId;
        } else entity = fixtureEntity(fixture);
        if (!entity || (action !== 'on' && action !== 'off')) {
          if (!fixture.states || !(action in fixture.states))
            throw new Refused(
              'fixture_control',
              `The ${fixture.label} has nothing to switch.`,
              400,
            );
          const stamp = new Date(now()).toISOString();
          const group = new Set([
            fixture.id,
            ...linkedFixtures(memory.fixtures ?? [], fixture).map((f) => f.id),
          ]);
          for (const f of memory.fixtures ?? [])
            if (group.has(f.id)) {
              f.state = action;
              f.updatedAt = stamp;
            }
          return { memory: save(memory), event: null };
        }
      }
      if (action !== 'on' && action !== 'off')
        throw new Refused('fixture_control', 'An entity can only be switched on or off.', 400);
      const result = lamp(entity!, action);
      const event = record('lamp', mode, result);
      // What the switch says about every fixture on that entity (`noteControl`).
      for (const f of memory.fixtures ?? []) {
        if (fixtureEntity(f) === result.entityId) f.state = action;
        for (const l of f.lights ?? [])
          if (l.entityId === result.entityId) f.lit = { ...f.lit, [l.part]: action === 'on' };
      }
      return { memory: save(memory), event };
    },
    'fixtures/state': (body) => {
      const {
        mode,
        fixtureId,
        state,
        fixture: model,
        remove,
        follow,
      } = parse(fixturesStateBodySchema, body);
      // A state with a model of its own is drawn and checked by the server.
      if (model) throw needsServer();
      const memory = demoDesk(mode);
      const target = fixtureIn(memory, fixtureId);
      const stamp = new Date(now()).toISOString();
      const states: Record<string, FixtureState> = { ...target.states };
      if (remove) delete states[remove];
      if (state && !states[state] && state !== 'on' && state !== 'off') throw needsServer();
      if (follow) {
        const s = states[follow.state];
        if (!s)
          throw new Refused(
            'fixture_state',
            `The ${target.label} has no “${follow.state}” state of its own to show.`,
            400,
          );
        for (const [name, other] of Object.entries(states))
          if (follow.stat && name !== follow.state && other.follows === follow.stat) {
            const { follows: _was, ...rest } = other;
            states[name] = rest;
          }
        const { follows: _had, ...rest } = s;
        states[follow.state] = follow.stat ? { ...rest, follows: follow.stat } : rest;
      }
      const next =
        state !== undefined
          ? state
          : remove && target.state === remove
            ? null
            : (target.state ?? null);
      const group = new Set([
        target.id,
        ...linkedFixtures(memory.fixtures ?? [], target).map((f) => f.id),
      ]);
      memory.fixtures = (memory.fixtures ?? []).map((f) => {
        if (!group.has(f.id)) return f;
        const copy: Fixture = { ...f, state: next, updatedAt: stamp };
        if (Object.keys(states).length) copy.states = states;
        else delete copy.states;
        return copy;
      });
      return save(memory);
    },
    'fixtures/save': (body) => {
      const { mode, fixture: input } = parse(fixturesSaveBodySchema, body);
      const memory = demoDesk(mode);
      const fixtures = memory.fixtures ?? [];
      const previous = input.id ? fixtures.find((f) => f.id === input.id) : undefined;
      if (input.id && !previous) throw unknownFixture();
      // A photo's model is the server's to keep.
      if (input.reference) throw needsServer();
      if (!previous && placedFixtures(memory).length >= MAX_FIXTURES)
        throw new Refused('fixture_limit', `Up to ${MAX_FIXTURES} fixtures are allowed.`, 409);
      const problem = fixtureProblem(input, memory.scene);
      if (problem) throw new Refused('fixture_place', problem, 400);
      if (fixtureEntities(input).some((e) => ![...DEMO_LIGHTS, ...DEMO_SWITCHES].includes(e)))
        throw new Refused(
          'fixture_entity',
          'Choose one of the configured lights or switches.',
          400,
        );
      const sources = new Set(lightSources(input.model).map((s) => s.part));
      const stray = input.lights?.find((l) => !sources.has(l.part));
      if (stray)
        throw new Refused(
          'fixture_light',
          `The model has no light source called “${stray.part}”.`,
          400,
        );
      return save({ ...memory, fixtures: savedFixtures(fixtures, previous, input, now()) });
    },
    'fixtures/layer': (body) => {
      const { mode, fixtureId, layer } = parse(fixturesLayerBodySchema, body);
      const memory = demoDesk(mode);
      const fixture = fixtureIn(memory, fixtureId);
      if (layer) fixture.layer = layer;
      else delete fixture.layer;
      fixture.updatedAt = new Date(now()).toISOString();
      return save(memory);
    },
    'fixtures/untrack': (body) => {
      const { mode, id } = parse(modeIdSchema, body);
      const memory = demoDesk(mode);
      delete fixtureIn(memory, id).track;
      memory.rules = withoutThings(memory.rules, [id]);
      return save(memory);
    },
    'fixtures/delete': (body) => {
      const { mode, fixtureId, fixtureIds, dismiss } = parse(fixturesDeleteBodySchema, body);
      const memory = demoDesk(mode);
      const ids = new Set(fixtureIds ?? [fixtureId!]);
      for (const gone of (memory.fixtures ?? []).filter((f) => ids.has(f.id)))
        if (dismiss && !isDismissed(gone.label, memory.dismissed ?? []))
          memory.dismissed = [...(memory.dismissed ?? []), gone.label].slice(-MAX_DISMISSED);
      const stamp = new Date(now()).toISOString();
      for (const f of memory.fixtures ?? [])
        if (f.seatedOn && (ids.has(f.id) || ids.has(f.seatedOn)))
          memory.fixtures = standUp(memory.fixtures ?? [], f.id, stamp);
      memory.fixtures = (memory.fixtures ?? []).filter((f) => !ids.has(f.id));
      memory.rules = withoutThings(memory.rules, [...ids]).map((r) => {
        if (!r.fixtureId || !ids.has(r.fixtureId)) return r;
        const { fixtureId: _gone, ...rest } = r;
        return rest;
      });
      return save(memory);
    },
    'fixtures/release': (body) => {
      const { mode, scene } = parse(fixturesReleaseBodySchema, body);
      const memory = demoDesk(mode);
      for (const f of memory.fixtures ?? []) if (f.scene === scene) f.scanned = true;
      return save(memory);
    },
    'fixtures/undismiss': (body) => {
      const { mode, label } = parse(fixturesUndismissBodySchema, body);
      const memory = demoDesk(mode);
      memory.dismissed = (memory.dismissed ?? []).filter((d) => d !== label);
      return save(memory);
    },
    'fixtures/seat': (body) => {
      const { mode, id, seat } = parse(fixturesSeatBodySchema, body);
      const memory = demoDesk(mode);
      const person = fixtureIn(memory, id);
      if (person.type !== 'person') throw new Refused('fixture_seat', 'Only a person sits.', 400);
      const stamp = new Date(now()).toISOString();
      if (!seat) return save({ ...memory, fixtures: standUp(memory.fixtures ?? [], id, stamp) });
      // A chair of the layout is made a thing first, from its picture: the server's.
      const seatId =
        'group' in seat
          ? memory.fixtures?.find((f) => f.scene === person.scene && f.builtIn === seat.group)?.id
          : seat.fixtureId;
      if (!seatId) throw needsServer();
      const next = seatPerson(memory.fixtures ?? [], id, seatId, stamp);
      if ('reason' in next) throw new Refused('fixture_seat', next.reason, 422);
      return save({ ...memory, fixtures: next });
    },
    'fixtures/away': (body) => {
      const { mode, id, away } = parse(fixturesAwayBodySchema, body);
      const memory = demoDesk(mode);
      const member = fixtureIn(memory, id);
      if (!isMember(member))
        throw new Refused('fixture_away', 'Only a person or a pet goes out.', 400);
      const stamp = new Date(now()).toISOString();
      const fixtures =
        away && member.seatedOn ? standUp(memory.fixtures ?? [], id, stamp) : memory.fixtures!;
      memory.fixtures = fixtures.map((f) => {
        if (f.id !== id) return f;
        const { away: _was, ...rest } = f;
        return { ...rest, ...(away ? { away: true as const } : {}), updatedAt: stamp };
      });
      return save(memory);
    },
  };

  return {
    /** One `/api/` call, by method, its path under `/api/` (with any query) and its JSON body. */
    handle(
      method: string,
      path: string,
      body?: unknown,
      headers: { ifNoneMatch?: string } = {},
    ): StaticReply {
      const [route = ''] = path.split('?');
      try {
        if (method === 'GET') {
          for (const [pattern, answer] of gets) {
            const m = route.match(pattern);
            if (m) return answer(m, headers.ifNoneMatch);
          }
          const saved = seed.get[path] ?? seed.get[route];
          if (saved !== undefined) return { status: 200, body: structuredClone(saved) };
          throw needsServer();
        }
        const post = posts[route];
        if (!post) throw needsServer();
        return { status: 200, body: post(body ?? {}) };
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        return { status: e.status, body: { error: { code: e.code, message: e.message } } };
      }
    },
  };
}

/** A thing saved, new or edited, as the server saves it (`saveFixture`), keeping the model's fit as it was. */
function savedFixtures(
  fixtures: Fixture[],
  previous: Fixture | undefined,
  input: z.output<typeof fixturesSaveBodySchema>['fixture'],
  at: number,
): Fixture[] {
  const stamp = new Date(at).toISOString();
  const { id: _id, model, room: roomInput, states: statesInput, ...rest } = input;
  const room = roomInput === undefined ? previous?.room : roomInput;
  const base = previous?.model;
  const savedModel: SavedItem = {
    ...uniqueParts(model),
    source: base?.source ?? 'demo',
    segmentRunId: base?.segmentRunId ?? null,
    swatches: base?.swatches ?? [],
    updatedAt: stamp,
    fit: base?.fit ?? null,
  };
  const seededStates = defaultFixtureStates({
    label: rest.label,
    archetype: savedModel.fit?.archetype,
    control: rest.control.kind,
    model: savedModel,
  });
  const states: Record<string, FixtureState> | undefined = statesInput
    ? Object.fromEntries(
        Object.entries(statesInput).map(([name, entry]) => {
          const was = previous?.states?.[name]?.model;
          return [
            name,
            {
              model: {
                ...uniqueParts(entry.model),
                source: was?.source ?? savedModel.source,
                segmentRunId: was?.segmentRunId ?? null,
                swatches: was?.swatches ?? savedModel.swatches,
                updatedAt: stamp,
                fit: was?.fit ?? null,
              },
              ...(entry.size ? { size: entry.size } : {}),
              ...(entry.reference !== undefined ? { reference: entry.reference } : {}),
            },
          ];
        }),
      )
    : (previous?.states ?? seededStates.states);
  const entity = fixtureEntity(input);
  const retyped = Boolean(previous && input.type && previous.type !== input.type);
  const samePlace =
    previous &&
    previous.scene === input.scene &&
    previous.surfaceId === input.surfaceId &&
    previous.turns === input.turns &&
    Math.abs(previous.at.x - input.at.x) < 1e-6 &&
    Math.abs(previous.at.y - input.at.y) < 1e-6;
  const fixture: Fixture = {
    ...rest,
    ...(room ? { room } : {}),
    id: previous?.id ?? crypto.randomUUID(),
    model: savedModel,
    ...(states ? { states } : {}),
    ...(previous?.lit ? { lit: previous.lit } : {}),
    state: retyped
      ? entity
        ? null
        : (seededStates.state ?? null)
      : previous
        ? entity && fixtureEntity(previous) !== entity
          ? null
          : (previous.state ?? null)
        : entity
          ? null
          : (seededStates.state ?? null),
    ...(previous?.link ? { link: previous.link } : {}),
    ...(previous?.track && samePlace ? { track: previous.track } : {}),
    ...(previous?.seen && samePlace ? { seen: previous.seen } : {}),
    ...(previous && retyped
      ? { drafts: withNewModel(previous, savedModel, stamp).drafts }
      : previous?.drafts?.length
        ? { drafts: previous.drafts }
        : {}),
    createdAt: previous?.createdAt ?? stamp,
    updatedAt: stamp,
  };
  if (!previous) return [...fixtures, fixture];
  const linked = new Set(linkedFixtures(fixtures, fixture).map((f) => f.id));
  return fixtures.map((f) =>
    f.id === previous.id
      ? fixture
      : linked.has(f.id)
        ? {
            ...f,
            label: fixture.label,
            model: fixture.model,
            ...(fixture.states ? { states: fixture.states } : {}),
            control: fixture.control,
            ...(fixture.type ? { type: fixture.type } : {}),
            lights: fixture.lights,
            lit: fixture.lit,
            state: fixture.state ?? null,
            updatedAt: stamp,
          }
        : f,
  );
}
