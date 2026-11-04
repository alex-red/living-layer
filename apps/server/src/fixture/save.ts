import { randomUUID } from 'node:crypto';
import {
  fixtureOutput,
  fixturesChooseBodySchema,
  fixturesSaveBodySchema,
  fixturesStateBodySchema,
  linkedFixtures,
  MAX_FIXTURES,
  defaultFixtureStates,
  fixtureEntity,
  fixtureEntities,
  lightSources,
  fixtureModel,
  fixtureProblem,
  stateSizeFor,
  fixtureSize,
  uniqueParts,
  MAX_DRAFTS,
  modelOrigin,
  withNewModel,
  type SavedItem,
  type Fixture,
  type FixtureInput,
  type FixtureState,
  placedFixtures,
} from '@livinglayer/domain';
import { LabError } from '../errors.js';
import { rescore } from '../item.js';
import { type RouteDeps } from '../route-deps.js';
import { type EvidenceStore } from '../store.js';
import { type Parsed } from './shared.js';

/** Whether a save leaves a fixture where it stood. */
const samePlace = (a: Fixture, b: FixtureInput) =>
  a.scene === b.scene &&
  a.surfaceId === b.surfaceId &&
  a.turns === b.turns &&
  Math.abs(a.at.x - b.at.x) < 1e-6 &&
  Math.abs(a.at.y - b.at.y) < 1e-6;

/** What each of a fixture's sources last reported, kept for those still on the same entity. */
function lastLit(
  previous: Fixture | undefined,
  lights: FixtureInput['lights'],
): Pick<Fixture, 'lit'> {
  const kept = Object.entries(previous?.lit ?? {}).filter(([part]) => {
    const was = previous?.lights?.find((l) => l.part === part)?.entityId;
    return was && lights?.some((l) => l.part === part && l.entityId === was);
  });
  return kept.length ? { lit: Object.fromEntries(kept) } : {};
}

/**
 * Put one of a fixture's earlier drafts back as its model, the current one
 * kept in its place, here and in its linked copies. Each pick is logged
 * with what it was chosen over (`fixture-picks.jsonl` in the data folder),
 * as examples of which modeller people prefer for which things.
 */
export function chooseDraft(
  store: EvidenceStore,
  { mode, fixtureId, draft }: Parsed<typeof fixturesChooseBodySchema>,
) {
  const memory = store.memory(mode);
  const fixture = memory.fixtures?.find((f) => f.id === fixtureId);
  if (!fixture) throw new LabError('fixture_missing', 'That fixture is gone.', 404);
  const chosen = fixture.drafts?.[draft];
  if (!chosen) throw new LabError('draft_missing', 'That draft is gone.', 404);
  const now = new Date().toISOString();
  const swap = <F extends Pick<Fixture, 'model' | 'drafts'>>(f: F): F => {
    const rest = (f.drafts ?? []).filter((d) => d !== chosen && d.model !== chosen.model);
    const kept = { model: f.model, origin: modelOrigin(f.model), replacedAt: now };
    return { ...f, model: chosen.model, drafts: [kept, ...rest].slice(0, MAX_DRAFTS) };
  };
  const group = new Set([
    fixture.id,
    ...linkedFixtures(memory.fixtures ?? [], fixture).map((f) => f.id),
  ]);
  memory.fixtures = (memory.fixtures ?? []).map((f) =>
    group.has(f.id) ? { ...swap(f), updatedAt: now } : f,
  );
  store.saveMemory(memory);
  store.appendPick({
    at: now,
    mode,
    label: fixture.label,
    archetype: chosen.model.fit?.archetype ?? fixture.model.fit?.archetype ?? null,
    chosen: chosen.origin,
    over: [
      modelOrigin(fixture.model),
      ...(fixture.drafts ?? []).filter((d) => d !== chosen).map((d) => d.origin),
    ],
    crop: chosen.model.fit?.crop ?? fixture.model.fit?.crop ?? null,
  });
  return memory;
}

/** Save a fixture, new or edited: where it stands, what it switches and its model are checked first. */
export async function saveFixture(
  { store, entities }: Pick<RouteDeps, 'store' | 'entities'>,
  { mode, fixture: input }: Parsed<typeof fixturesSaveBodySchema>,
) {
  const memory = store.memory(mode);
  const fixtures = memory.fixtures ?? [];
  const previous = input.id ? fixtures.find((f) => f.id === input.id) : undefined;
  if (input.id && !previous)
    throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
  if (!previous && placedFixtures(memory).length >= MAX_FIXTURES)
    throw new LabError('fixture_limit', `Up to ${MAX_FIXTURES} fixtures are allowed.`, 409);
  const problem = fixtureProblem(input, memory.scene);
  if (problem) throw new LabError('fixture_place', problem, 400);
  const entity = fixtureEntity(input);
  if (fixtureEntities(input).some((e) => !entities(mode).includes(e)))
    throw new LabError('fixture_entity', 'Choose one of the configured lights or switches.', 400);
  const sources = new Set(lightSources(input.model).map((s) => s.part));
  const stray = input.lights?.find((l) => !sources.has(l.part));
  if (stray)
    throw new LabError(
      'fixture_light',
      `The model has no light source called “${stray.part}”.`,
      400,
    );
  const referenceRun = input.reference ? store.getRun(input.reference.runId) : undefined;
  if (
    input.reference &&
    (!referenceRun || !input.reference.asset.startsWith(`${input.reference.runId}/`))
  )
    throw new LabError(
      'fixture_reference',
      'The reference photo is not one of the saved runs.',
      400,
    );
  const now = new Date().toISOString();
  const retyped = Boolean(previous && input.type && previous.type !== input.type);
  const { id: _id, model, room: roomInput, states: statesInput, ...rest } = input;
  // Its own place in the room's view: kept unless the save says otherwise, null clears it.
  const room = roomInput === undefined ? previous?.room : roomInput;
  // What the model was drafted as: the fixture before, or the draft it came from.
  const drafted =
    referenceRun?.status === 'completed' ? fixtureOutput.draft(referenceRun) : undefined;
  const base = previous?.model ?? drafted?.model;
  const savedModel: SavedItem = {
    ...uniqueParts(model),
    source: base?.source ?? (mode === 'demo' ? 'demo' : 'sampled'),
    segmentRunId: base?.segmentRunId ?? null,
    swatches: base?.swatches ?? [],
    updatedAt: now,
    // An edit keeps its fit record, scored again against the same crop.
    fit: await rescore(store, model, base?.fit),
  };
  const seeded = defaultFixtureStates({
    label: rest.label,
    archetype: drafted?.archetype ?? savedModel.fit?.archetype,
    control: rest.control.kind,
    model: savedModel,
  });
  const states: Record<string, FixtureState> | undefined = statesInput
    ? Object.fromEntries(
        Object.entries(statesInput).map(([stateName, entry]) => {
          const prevState = previous?.states?.[stateName]?.model;
          return [
            stateName,
            {
              model: {
                ...uniqueParts(entry.model),
                source: prevState?.source ?? savedModel.source,
                segmentRunId: prevState?.segmentRunId ?? null,
                swatches: prevState?.swatches ?? savedModel.swatches,
                updatedAt: now,
                fit: prevState?.fit ?? null,
              },
              ...(entry.size ? { size: entry.size } : {}),
              ...(entry.reference !== undefined ? { reference: entry.reference } : {}),
            },
          ];
        }),
      )
    : (previous?.states ?? drafted?.states ?? seeded.states);
  if (states) {
    for (const entry of Object.values(states)) {
      if (entry.size) {
        const sizeProblem = fixtureProblem({ ...input, size: entry.size }, memory.scene);
        if (sizeProblem) throw new LabError('fixture_place', sizeProblem, 400);
      }
    }
  }
  const fixture: Fixture = {
    ...rest,
    ...(room ? { room } : {}),
    id: previous?.id ?? randomUUID(),
    model: savedModel,
    ...(states ? { states } : {}),
    // A source keeps what its entity last reported while it stays on that entity.
    ...lastLit(previous, input.lights),
    // A new entity starts with no known state; a pet starts in its default pose.
    // Another kind of thing starts in that kind's own state.
    state: retyped
      ? entity
        ? null
        : (seeded.state ?? null)
      : previous
        ? entity
          ? fixtureEntity(previous) === entity
            ? (previous.state ?? null)
            : null
          : (previous.state ?? null)
        : entity
          ? null
          : (drafted?.state ?? seeded.state ?? null),
    ...(previous?.link ? { link: previous.link } : {}),
    // The camera keeps following it unless it was moved by hand.
    ...(previous?.track && samePlace(previous, input) ? { track: previous.track } : {}),
    ...(previous?.seen && samePlace(previous, input) ? { seen: previous.seen } : {}),
    // A change of what it is keeps the model it had, to pick back from Earlier drafts.
    ...(previous && retyped
      ? { drafts: withNewModel(previous, savedModel, now).drafts }
      : previous?.drafts?.length
        ? { drafts: previous.drafts }
        : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  // The same thing in its other scenes is renamed, remodelled and rewired with it.
  const linked = new Set(linkedFixtures(fixtures, fixture).map((f) => f.id));
  memory.fixtures = previous
    ? fixtures.map((f) =>
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
                updatedAt: now,
              }
            : f,
      )
    : [...fixtures, fixture];
  store.saveMemory(memory);
  return memory;
}

/**
 * Switch a fixture's active state, or add/edit/remove a custom state with its
 * own unique fixture model, size or reference.
 */
export function setFixtureState(
  store: EvidenceStore,
  {
    mode,
    fixtureId,
    state,
    fixture: stateInput,
    remove,
    follow,
  }: Parsed<typeof fixturesStateBodySchema>,
) {
  const memory = store.memory(mode);
  const target = memory.fixtures?.find((f) => f.id === fixtureId);
  if (!target)
    throw new LabError('fixture_unknown', 'That fixture is not in this desk memory.', 404);
  const now = new Date().toISOString();
  const states: Record<string, FixtureState> = { ...(target.states ?? {}) };
  if (remove) delete states[remove];
  if (state) {
    if (stateInput) {
      const prev = states[state]?.model ?? fixtureModel(target, state);
      // A taller or shorter model takes its own height, unless a size is given.
      const had = { size: states[state]?.size ?? target.size, model: prev };
      const size = stateInput.size ?? stateSizeFor(had, stateInput.model) ?? undefined;
      if (size) {
        const problem = fixtureProblem({ ...target, size }, memory.scene);
        if (problem) throw new LabError('fixture_place', problem, 400);
      }
      states[state] = {
        model: {
          ...uniqueParts(stateInput.model),
          source: prev.source,
          segmentRunId: prev.segmentRunId,
          swatches: prev.swatches,
          updatedAt: now,
          fit: prev.fit,
        },
        ...(size ? { size } : states[state]?.size ? { size: states[state]!.size } : {}),
        ...(stateInput.reference !== undefined
          ? { reference: stateInput.reference }
          : states[state]?.reference !== undefined
            ? { reference: states[state]!.reference }
            : {}),
        ...(stateInput.follows
          ? { follows: stateInput.follows }
          : states[state]?.follows
            ? { follows: states[state]!.follows }
            : {}),
      };
    } else if (!states[state] && state !== 'on' && state !== 'off') {
      const currentModel = fixtureModel(target);
      states[state] = {
        model: { ...currentModel, updatedAt: now },
        size: fixtureSize(target),
      };
    }
  }
  if (follow) {
    const s = states[follow.state];
    if (!s)
      throw new LabError(
        'fixture_state',
        `The ${target.label} has no “${follow.state}” state of its own to show.`,
        400,
      );
    // A stat shows one state: any other that followed it stops.
    for (const [name, other] of Object.entries(states))
      if (follow.stat && name !== follow.state && other.follows === follow.stat) {
        const { follows: _was, ...rest } = other;
        states[name] = rest;
      }
    const { follows: _had, ...rest } = s;
    states[follow.state] = follow.stat ? { ...rest, follows: follow.stat } : rest;
  }
  const nextState =
    state !== undefined ? state : remove && target.state === remove ? null : (target.state ?? null);
  const nextStates = Object.keys(states).length ? states : undefined;
  const group = new Set([
    target.id,
    ...linkedFixtures(memory.fixtures ?? [], target).map((f) => f.id),
  ]);
  memory.fixtures = (memory.fixtures ?? []).map((f) => {
    if (!group.has(f.id)) return f;
    const copy: Fixture = { ...f, state: nextState, updatedAt: now };
    if (nextStates) copy.states = nextStates;
    else delete copy.states;
    return copy;
  });
  store.saveMemory(memory);
  return memory;
}
