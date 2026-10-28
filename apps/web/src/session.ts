import type { DeskMemory, Mode } from '@livinglayer/domain';
import type { SceneKind } from './iso/ScenePicker';

/**
 * The session lives in this browser: what the person chose (scene, view,
 * camera source…) and a copy of each mode's desk memory, written as they go.
 * A save file is the same object, so export and import are one format.
 */
export interface Prefs {
  mode: Mode;
  workScene: SceneKind | null;
  stageView: 'photo' | 'iso';
  overlay: boolean;
  concept: string;
  fixturePosition: string;
  /** '' for this device's camera, else the id of a network camera. */
  cameraSource: string;
  sideTab: 'runs' | 'inspect' | 'session' | 'setup';
  logKind: string;
  logMode: string;
  failuresOnly: boolean;
}
export interface SessionSave {
  app: 'livinglayer';
  version: 1;
  savedAt: string;
  prefs: Partial<Prefs>;
  desks: Partial<Record<Mode, DeskMemory>>;
}

const KEY = 'livinglayer.session';

export const DEFAULT_PREFS: Prefs = {
  mode: 'fixture',
  workScene: null,
  stageView: 'photo',
  overlay: true,
  concept: 'mug',
  fixturePosition: 'centre',
  cameraSource: '',
  sideTab: 'runs',
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
  one('mode', among('fixture', 'live'));
  one('workScene', among(null, 'office', 'desk', 'fridge', 'custom'));
  one('stageView', among('photo', 'iso'));
  one('overlay', (v) => typeof v === 'boolean');
  one('concept', (v) => text(v) && (v as string).trim().length > 0);
  one('fixturePosition', text);
  one('cameraSource', text);
  one('sideTab', among('runs', 'inspect', 'session', 'setup'));
  one('logKind', text);
  one('logMode', among('all', 'fixture', 'live'));
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
export function clearSession() {
  try {
    localStorage.removeItem(KEY);
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
  for (const mode of ['fixture', 'live'] as const) {
    const desk = save.desks?.[mode];
    if (desk && desk.mode === mode) desks[mode] = desk;
  }
  return {
    app: 'livinglayer',
    version: 1,
    savedAt: typeof save.savedAt === 'string' ? save.savedAt : new Date().toISOString(),
    prefs: save.prefs && typeof save.prefs === 'object' ? save.prefs : {},
    desks,
  };
}
export function downloadSave(save: SessionSave) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `livinglayer-save-${save.savedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
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
