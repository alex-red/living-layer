import { upgradeMemory, type DeskMemory, type Mode } from '@livinglayer/domain';
import type { WorkScene } from './workspace/progress';

/**
 * The session lives in this browser: what the person chose (scene, view,
 * camera source…) and a copy of each mode's desk memory, written as they go.
 * A save file is the same object, so export and import are one format.
 */
/** The canvas: the photo, the iso room, or both side by side. */
export type StageView = 'photo' | 'iso' | 'split';
export interface Prefs {
  mode: Mode;
  workScene: WorkScene | null;
  stageView: StageView;
  overlay: boolean;
  /** Canvas layers besides the masks: the mug's trail, saved zones, a room's picture, and its calibration. */
  trail: boolean;
  zones: boolean;
  picture: boolean;
  corner: boolean;
  /** Each thing's stats over the camera and in the room. */
  stats: boolean;
  /** On the room's picture, fixtures as the picture shows them or as their models. */
  fixtureLook: 'picture' | 'model';
  concept: string;
  demoPosition: string;
  /** '' for this device's camera, else the id of a network camera. */
  cameraSource: string;
  /** Whether the live camera was on, so a reload or a dropped stream opens it again. */
  cameraOn: boolean;
  /** Over the live camera, the tracked objects and fixtures where they were last seen. */
  tracking: boolean;
  /** Whether the activity drawer is open. */
  drawer: boolean;
  /** What a drag on the canvas does. */
  tool: 'select' | 'scale' | 'hand' | 'brush';
  /** The iso canvas: the room, or the layout or a model open in its editor. */
  isoPanel: 'room' | 'scene' | 'item';
  /** The object whose model is open; '' for the mug. */
  modelOf: string;
  /** The surface the iso view shows. */
  isoSurfaceId: string;
  /** On phones, whether the outline sheet is up. */
  outlineOpen: boolean;
  logKind: string;
  logMode: string;
  failuresOnly: boolean;
}
export interface SessionSave {
  app: 'livinglayer';
  version: 1;
  savedAt: string;
  /** What the person called it, for a named save or a file exported from one. */
  name?: string;
  prefs: Partial<Prefs>;
  desks: Partial<Record<Mode, DeskMemory>>;
}

const KEY = 'livinglayer.session';

export const DEFAULT_PREFS: Prefs = {
  mode: 'demo',
  workScene: null,
  stageView: 'photo',
  overlay: true,
  trail: true,
  zones: true,
  picture: true,
  corner: true,
  stats: true,
  fixtureLook: 'picture',
  concept: 'mug',
  demoPosition: 'centre',
  cameraSource: '',
  cameraOn: false,
  tracking: true,
  drawer: false,
  tool: 'select',
  isoPanel: 'room',
  modelOf: '',
  isoSurfaceId: '',
  outlineOpen: false,
  logKind: 'all',
  logMode: 'all',
  failuresOnly: false,
};
/** Saved choices over the defaults, keeping only values of the right kind. */
export function prefsOf(saved: Partial<Prefs> | undefined): Prefs {
  const out = { ...DEFAULT_PREFS };
  const one = <K extends keyof Prefs>(key: K, ok: (v: unknown) => boolean) => {
    const v = saved?.[key];
    if (v !== undefined && ok(v)) out[key] = v as Prefs[K];
  };
  const among =
    (...values: unknown[]) =>
    (v: unknown) =>
      values.includes(v);
  const text = (v: unknown) => typeof v === 'string' && v.length <= 200;
  one('mode', among('demo', 'live'));
  one('workScene', among(null, 'office', 'desk', 'fridge', 'custom', 'custom-desk'));
  one('stageView', among('photo', 'iso', 'split'));
  one('overlay', (v) => typeof v === 'boolean');
  one('trail', (v) => typeof v === 'boolean');
  one('zones', (v) => typeof v === 'boolean');
  one('picture', (v) => typeof v === 'boolean');
  one('corner', (v) => typeof v === 'boolean');
  one('stats', (v) => typeof v === 'boolean');
  one('fixtureLook', among('picture', 'model'));
  one('concept', (v) => text(v) && (v as string).trim().length > 0);
  one('demoPosition', text);
  one('cameraSource', text);
  one('cameraOn', (v) => typeof v === 'boolean');
  one('tracking', (v) => typeof v === 'boolean');
  one('drawer', (v) => typeof v === 'boolean');
  one('tool', among('select', 'scale', 'hand'));
  one('isoPanel', among('room', 'scene', 'item'));
  one('modelOf', text);
  one('isoSurfaceId', text);
  one('outlineOpen', (v) => typeof v === 'boolean');
  one('logKind', text);
  one('logMode', among('all', 'demo', 'live'));
  one('failuresOnly', (v) => typeof v === 'boolean');
  return out;
}

export function readSession(): SessionSave | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSave(raw) : null;
  } catch {
    return null;
  }
}
/** False when the browser refused: private mode, blocked storage, or full. */
export function writeSession(prefs: Partial<Prefs>, desks: SessionSave['desks']): boolean {
  const save: SessionSave = {
    app: 'livinglayer',
    version: 1,
    savedAt: new Date().toISOString(),
    prefs,
    desks,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}
/**
 * Small view state that belongs to this browser alone and isn't part of a
 * save file: folded inspector sections, each view's zoom. Missing or blocked
 * storage just means starting from the defaults.
 */
const UI_KEY = 'livinglayer.ui';
function readUiAll(): Record<string, unknown> {
  try {
    const data = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as unknown;
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
export function readUi(key: string): unknown {
  return readUiAll()[key];
}
export function writeUi(key: string, value: unknown) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...readUiAll(), [key]: value }));
  } catch {
    /* storage refused: the view just won't be remembered */
  }
}
export function clearSession() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(UI_KEY);
  } catch {
    /* nothing stored, nothing to clear */
  }
}

/** A save file's contents, or a reason it isn't one. */
export function parseSave(text: string): SessionSave {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not JSON.');
  }
  const save = data as Partial<SessionSave> | null;
  if (!save || save.app !== 'livinglayer' || save.version !== 1)
    throw new Error('This is not a Living Layer save.');
  const desks: SessionSave['desks'] = {};
  for (const mode of ['demo', 'live'] as const) {
    const desk = save.desks?.[mode];
    if (desk && desk.mode === mode) desks[mode] = upgradeMemory(desk);
  }
  // Saves from before the offline mode was renamed from `fixture` to `demo`.
  const old = (save.desks as Record<string, DeskMemory | undefined> | undefined)?.fixture;
  if (!desks.demo && old && (old.mode as string) === 'fixture')
    desks.demo = upgradeMemory(
      JSON.parse(
        JSON.stringify(old)
          .replaceAll('"mode":"fixture"', '"mode":"demo"')
          .replaceAll('"source":"fixture"', '"source":"demo"')
          .replaceAll('light.fixture_', 'light.demo_'),
      ) as DeskMemory,
    );
  const prefs: Record<string, unknown> =
    save.prefs && typeof save.prefs === 'object' ? { ...save.prefs } : {};
  if (prefs.mode === 'fixture') prefs.mode = 'demo';
  if (prefs.logMode === 'fixture') prefs.logMode = 'demo';
  if ('fixturePosition' in prefs && !('demoPosition' in prefs))
    prefs.demoPosition = prefs.fixturePosition;
  delete prefs.fixturePosition;
  const name = typeof save.name === 'string' ? saveName(save.name) : '';
  return {
    app: 'livinglayer',
    version: 1,
    savedAt: typeof save.savedAt === 'string' ? save.savedAt : new Date().toISOString(),
    ...(name ? { name } : {}),
    prefs: prefs as Partial<Prefs>,
    desks,
  };
}
export function downloadSave(save: SessionSave) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  const stamp = save.savedAt.slice(0, 19).replace(/[:T]/g, '-');
  const slug = (save.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  a.download = `livinglayer-${slug || 'save'}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Saves the person named, kept in this browser beside the autosave: each one
 * a whole save, so loading one puts both desks and the view back as they were.
 */
export interface NamedSave {
  id: string;
  name: string;
  save: SessionSave;
}
const SAVES_KEY = 'livinglayer.saves';
export const SAVE_NAME_MAX = 60;
/** A name tidied for a save: one line, trimmed, not too long; '' when nothing is left. */
export function saveName(name: string) {
  return name.replace(/\s+/g, ' ').trim().slice(0, SAVE_NAME_MAX);
}
/** Named saves from storage's text, newest first, dropping any that no longer read. */
export function parseSaves(text: string | null): NamedSave[] {
  let data: unknown;
  try {
    data = JSON.parse(text ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: NamedSave[] = [];
  for (const entry of data as Partial<NamedSave>[]) {
    const name = typeof entry?.name === 'string' ? saveName(entry.name) : '';
    if (typeof entry?.id !== 'string' || !name) continue;
    try {
      out.push({ id: entry.id, name, save: { ...parseSave(JSON.stringify(entry.save)), name } });
    } catch {
      /* not a save any more: leave it out */
    }
  }
  return out.sort((a, b) => b.save.savedAt.localeCompare(a.save.savedAt));
}
/** The list with this save added, or put in place of the one with its id. */
export function withSave(list: NamedSave[], entry: NamedSave): NamedSave[] {
  return [entry, ...list.filter((s) => s.id !== entry.id)];
}
export function readSaves(): NamedSave[] {
  try {
    return parseSaves(localStorage.getItem(SAVES_KEY));
  } catch {
    return [];
  }
}
/** False when the browser refused: private mode, blocked storage, or full. */
export function writeSaves(list: NamedSave[]): boolean {
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** A desk with nothing remembered: the demo as it ships. */
export function emptyDesk(mode: Mode): DeskMemory {
  return {
    mode,
    object: null,
    observation: null,
    zone: null,
    lastDecision: null,
    fixedCamera: false,
    surface: null,
    scene: null,
    history: [],
    placement: null,
    others: [],
    rules: [],
    item: null,
  };
}
