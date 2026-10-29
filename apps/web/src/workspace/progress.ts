import {
  DEMO_SURFACE,
  ISO_PRESETS,
  ISO_SCENE_PARENT,
  pinFits,
  type DeskMemory,
  type IsoSceneKind,
  type Mode,
} from '@livinglayer/domain';

/** The scene the work is in: a preset room or close view, or the person's own scene. */
export type WorkScene = IsoSceneKind | 'custom';

/**
 * What the inspector shows: a node of the scene outline. `main` is the mug,
 * the main object, and its zone is the `main` rule.
 */
export type Selection =
  | { kind: 'room' }
  | { kind: 'view' }
  | { kind: 'surface'; id: string }
  | { kind: 'object'; id: string }
  | { kind: 'suggested'; index: number }
  | { kind: 'add' }
  | { kind: 'rule'; id: string }
  | { kind: 'new-rule' }
  | { kind: 'fixture'; id: string }
  | { kind: 'new-fixture' }
  /** A lamp that is part of a room's layout: `scene~propId`. */
  | { kind: 'lamp'; id: string };

export type StepId = 'office' | 'desk' | 'objects' | 'rule' | 'run';
export type StepState = 'done' | 'current' | 'todo' | 'locked';
export interface Step {
  id: StepId;
  label: string;
  state: StepState;
  /** One plain sentence: what is done, or what to do next. */
  detail: string;
}
export interface Progress {
  steps: Step[];
  /** The first step not done yet, or null once everything has run once. */
  next: StepId | null;
  /** The room the work is in, or null before one is chosen. */
  room: WorkScene | null;
  /** The close view inside the room, when it has one: the office desk. */
  view: IsoSceneKind | null;
  /** Whether the desk (or the room's main surface) is pinned to a camera frame. */
  pinned: boolean;
}

/** The room a scene belongs to: the office desk is in the office. */
export function roomOf(scene: WorkScene): WorkScene {
  return scene === 'custom' ? scene : (ISO_SCENE_PARENT[scene] ?? scene);
}
/** The close view inside a room, if it has one. */
export function viewOf(room: WorkScene): IsoSceneKind | null {
  if (room === 'custom') return null;
  const kinds = Object.keys(ISO_PRESETS) as IsoSceneKind[];
  return kinds.find((k) => ISO_SCENE_PARENT[k] === room) ?? null;
}

/**
 * How far the guided setup has got. Setup runs in order: the room, then the
 * desk inside it, then objects, a rule and one check. Only the desk waits for
 * the room; the later steps are suggestions, never locks, so an expert can
 * still work in any order.
 */
export function sceneProgress({
  mode,
  workScene,
  memory,
}: {
  mode: Mode;
  workScene: WorkScene | null;
  memory?: DeskMemory | null;
}): Progress {
  const room = workScene ? roomOf(workScene) : null;
  const view = room ? viewOf(room) : null;
  const pin = memory?.surface ?? (mode === 'demo' ? DEMO_SURFACE : null);
  const pinned = Boolean(
    room &&
    pin &&
    (room === 'custom'
      ? pin.scene === 'custom' && Boolean(memory?.scene)
      : pinFits(pin, view ?? room)),
  );
  const objects = (memory?.object ? 1 : 0) + (memory?.others?.length ?? 0);
  const rules = (memory?.zone ? 1 : 0) + (memory?.rules?.length ?? 0);
  const ran = Boolean(memory?.lastDecision || memory?.rules?.some((r) => r.lastDecision));
  const roomLabel = room === 'custom' ? (memory?.scene?.label ?? 'your room') : room;
  const deskLabel = view ? ISO_PRESETS[view].label : room ? 'Main surface' : 'Office desk';

  const done: Record<StepId, boolean> = {
    office: Boolean(room),
    desk: pinned,
    objects: objects > 0,
    rule: rules > 0,
    run: ran,
  };
  const detail: Record<StepId, [string, string]> = {
    office: [
      `Working in the ${room === 'custom' ? roomLabel : ISO_PRESETS[room as IsoSceneKind]?.label.toLowerCase()}.`,
      'Photograph your office, or use the demo office.',
    ],
    desk: [
      mode === 'demo' && !memory?.surface
        ? 'The demo desk is already pinned.'
        : 'The desktop is pinned to the camera frame.',
      view
        ? 'Get close to the desk and pin its top on a photo.'
        : 'Pin the main surface on a photo.',
    ],
    objects: [
      `${objects} object${objects === 1 ? '' : 's'} remembered.`,
      'Find the mug on the desk and confirm it.',
    ],
    rule: [`${rules} zone${rules === 1 ? '' : 's'} saved.`, 'Draw a zone the mug should be in.'],
    run: ['The lamp rule has run.', 'Move the mug, track it, and check the zone.'],
  };
  const label: Record<StepId, string> = {
    office: room === 'custom' ? 'Room' : 'Office',
    desk: deskLabel,
    objects: 'Objects',
    rule: 'Zone and light',
    run: 'Run it',
  };

  const order: StepId[] = ['office', 'desk', 'objects', 'rule', 'run'];
  const next = order.find((id) => !done[id]) ?? null;
  const steps = order.map((id): Step => {
    const state: StepState = done[id]
      ? 'done'
      : id === next
        ? 'current'
        : id === 'desk' && !done.office
          ? 'locked'
          : 'todo';
    return {
      id,
      label: label[id],
      state,
      detail: state === 'locked' ? 'Set up the office first.' : detail[id][done[id] ? 0 : 1],
    };
  });
  return { steps, next, room, view, pinned };
}

/** Where a step is worked on. */
export function selectionForStep(id: StepId, memory?: DeskMemory | null): Selection {
  switch (id) {
    case 'office':
      return { kind: 'room' };
    case 'desk':
      return { kind: 'view' };
    case 'objects':
      return memory?.object ? { kind: 'object', id: 'main' } : { kind: 'add' };
    case 'rule':
    case 'run':
      return { kind: 'rule', id: 'main' };
  }
}

/** A selection as a URL hash, so a reload keeps your place. */
export function selectionHash(s: Selection | null): string {
  if (!s) return '';
  switch (s.kind) {
    case 'surface':
    case 'object':
    case 'rule':
    case 'fixture':
    case 'lamp':
      return `#${s.kind}/${encodeURIComponent(s.id)}`;
    case 'suggested':
      return `#suggested/${s.index}`;
    default:
      return `#${s.kind}`;
  }
}
export function parseSelection(hash: string): Selection | null {
  const [kind, raw] = hash.replace(/^#/, '').split('/', 2);
  const id = raw ? decodeURIComponent(raw) : '';
  switch (kind) {
    case 'room':
    case 'view':
    case 'add':
    case 'new-rule':
    case 'new-fixture':
      return { kind };
    case 'surface':
    case 'object':
    case 'rule':
    case 'fixture':
    case 'lamp':
      return id ? { kind, id } : null;
    case 'suggested': {
      const index = Number(id);
      return Number.isInteger(index) && index >= 0 ? { kind, index } : null;
    }
    default:
      return null;
  }
}
export const sameSelection = (a: Selection | null, b: Selection | null) =>
  selectionHash(a) === selectionHash(b);
