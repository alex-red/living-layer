import { useEffect, useRef, useState } from 'react';
import type { Mode, RunKind, DemoPosition } from '@livinglayer/domain';
import { DEMO_POSITIONS } from '@livinglayer/domain';
import {
  clearSession,
  downloadSave,
  emptyDesk,
  parseSave,
  prefsOf,
  readSaves,
  readUi,
  saveName,
  withSave,
  writeSaves,
  writeSession,
  writeUi,
  type NamedSave,
  type Prefs,
  type SessionSave,
} from '../../session';
import { SHORTCUTS } from '../../shortcuts';
import { RUN_KINDS, UNDO_LIMIT } from './helpers';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import type { DeskSlice } from './desk';
import type { FollowStateSlice } from './follow-state';
import type { CameraSlice } from './camera';
import type { ObservationSlice } from './observation';
import type { TrackingSlice } from './tracking';
import type { NavigationSlice } from './navigation';
import type { AiSlice } from './ai';
import type { FixturesSlice } from './fixtures';
import type { CalibrationSlice } from './calibration';
import type { ProbesSlice } from './probes';
import { useStableSlice } from './stable';

/** The Saves slice of the lab's state. */
export function useSavesSlice(
  deps: ViewSlice &
    FeedbackSlice &
    RunLogSlice &
    DeskSlice &
    FollowStateSlice &
    CameraSlice &
    ObservationSlice &
    TrackingSlice &
    NavigationSlice &
    AiSlice &
    FixturesSlice &
    CalibrationSlice &
    ProbesSlice,
) {
  const {
    boot,
    busy,
    camera,
    cameraSource,
    cameraWanted,
    changeMode,
    concept,
    demoPosition,
    deskReady,
    drawer,
    edits,
    failuresOnly,
    fixtureLook,
    isoPanel,
    isoSurfaceId,
    logKind,
    logMode,
    memories,
    memory,
    mode,
    modelOf,
    outlineOpen,
    overlay,
    redo,
    refresh,
    restoreDesk,
    setBusy,
    setCameraSource,
    setCameraWanted,
    setChoosingScene,
    setConcept,
    setDemoPosition,
    setDrawer,
    setDrawing,
    setError,
    setFailuresOnly,
    setFixtureLook,
    setHistoryTick,
    setIsoPanel,
    setIsoSurfaceId,
    setLastAiRun,
    setLogKind,
    setLogMode,
    setMessage,
    setOutlineOpen,
    setOverlay,
    setPinning,
    setReopenTries,
    setRuleDraft,
    setSelection,
    setShowCorner,
    setShowPicture,
    setShowTrail,
    setShowZones,
    setStageView,
    setToolRaw: setTool,
    setTrackingRaw: setTracking,
    setWorkScene,
    showCorner,
    showPicture,
    showTrail,
    showZones,
    stageView,
    stopCamera,
    tool,
    tracking,
    undo,
    workScene,
  } = deps;
  const [savedAt, setSavedAt] = useState(boot.save?.savedAt ?? '');
  const [storageOk, setStorageOk] = useState(true);
  const prefs: Prefs = {
    mode,
    workScene,
    stageView,
    overlay,
    trail: showTrail,
    zones: showZones,
    picture: showPicture,
    corner: showCorner,
    fixtureLook,
    concept,
    demoPosition,
    cameraSource,
    cameraOn: cameraWanted,
    tracking,
    drawer,
    tool,
    isoPanel,
    modelOf: modelOf ?? '',
    isoSurfaceId: isoSurfaceId ?? '',
    outlineOpen,
    logKind,
    logMode,
    failuresOnly,
  };
  function saveNow() {
    const ok = writeSession(prefs, memories);
    setStorageOk(ok);
    if (ok) setSavedAt(new Date().toISOString());
    return ok;
  }
  useEffect(() => {
    if (!deskReady) return;
    const timer = window.setTimeout(saveNow, 400);
    return () => window.clearTimeout(timer);
  }, [deskReady, memories, ...Object.values(prefs)]);
  // A reload or a closed tab can come sooner than the pause autosave waits for, so save on the way out too.
  const flush = useRef(() => {});
  flush.current = () => {
    if (deskReady) saveNow();
  };
  useEffect(() => {
    const leave = () => flush.current();
    window.addEventListener('pagehide', leave);
    // A hot reload that remounts the lab reads the save again, so it must be current too.
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, []);
  async function stepHistory(back: boolean) {
    const from = back ? undo : redo;
    const to = back ? redo : undo;
    const target = from.current[mode].at(-1);
    const current = memory;
    if (!target || !current || busy || camera) return;
    setBusy(back ? 'undo' : 'redo');
    setError('');
    try {
      await restoreDesk(target);
      from.current[mode] = from.current[mode].slice(0, -1);
      to.current[mode] = [...to.current[mode], current].slice(-UNDO_LIMIT);
      edits.current++;
      setHistoryTick((t) => t + 1);
      setDrawing(false);
      setPinning(null);
      setMessage(
        back ? `Undone. Redo with ${SHORTCUTS.find((k) => k.action === 'redo')!.keys}.` : 'Redone.',
      );
    } catch (e) {
      setError(e instanceof Error ? e : 'Undo failed.');
    } finally {
      setBusy('');
    }
  }
  function currentSave(name?: string): SessionSave {
    return {
      app: 'livinglayer',
      version: 1,
      savedAt: new Date().toISOString(),
      ...(name ? { name } : {}),
      prefs,
      desks: memories,
    };
  }
  // Named saves: the person's own copies in this browser, and the one they last saved or loaded.
  const [saves, setSaves] = useState<NamedSave[]>(readSaves);
  const [activeSaveId, setActiveSaveId] = useState(() => {
    const id = readUi('activeSave');
    return typeof id === 'string' ? id : '';
  });
  const activeSave = saves.find((s) => s.id === activeSaveId) ?? null;
  const savedEdits = useRef(0);
  /** Whether there are edits no named save holds, so loading another would lose them. */
  const unsaved = !activeSave || edits.current !== savedEdits.current;
  function markActive(entry: NamedSave | null) {
    setActiveSaveId(entry?.id ?? '');
    writeUi('activeSave', entry?.id ?? '');
    savedEdits.current = edits.current;
  }
  function storeSaves(list: NamedSave[]) {
    const ok = writeSaves(list);
    if (ok) setSaves(list);
    else
      setError(
        'This browser would not store the save. Delete an old save or export this one to a file.',
      );
    return ok;
  }
  /** Keep what's on the desks under a name; a name already used updates that save. */
  function saveAs(name: string) {
    const clean = saveName(name);
    if (!clean) return false;
    saveNow();
    const same = saves.find((s) => s.name.toLowerCase() === clean.toLowerCase());
    const entry: NamedSave = {
      id: same?.id ?? crypto.randomUUID(),
      name: clean,
      save: currentSave(clean),
    };
    if (!storeSaves(withSave(saves, entry))) return false;
    markActive(entry);
    setMessage(same ? `Updated “${clean}”.` : `Saved as “${clean}”.`);
    return true;
  }
  /** Put what's on the desks into an existing named save. */
  function updateSave(id: string) {
    const entry = saves.find((s) => s.id === id);
    if (!entry) return false;
    saveNow();
    const next = { ...entry, save: currentSave(entry.name) };
    if (!storeSaves(withSave(saves, next))) return false;
    markActive(next);
    return true;
  }
  function renameSave(id: string, name: string) {
    const clean = saveName(name);
    const entry = saves.find((s) => s.id === id);
    if (!clean || !entry) return false;
    const taken = saves.some((s) => s.id !== id && s.name.toLowerCase() === clean.toLowerCase());
    if (taken) {
      setError(`There is already a save called “${clean}”.`);
      return false;
    }
    return storeSaves(
      saves.map((s) => (s.id === id ? { ...s, name: clean, save: { ...s.save, name: clean } } : s)),
    );
  }
  function deleteSave(id: string) {
    const entry = saves.find((s) => s.id === id);
    if (!entry || !storeSaves(saves.filter((s) => s.id !== id))) return;
    if (id === activeSaveId) markActive(null);
    setMessage(`Deleted “${entry.name}”.`);
  }
  async function loadSave(id: string) {
    const entry = saves.find((s) => s.id === id);
    if (!entry) return;
    if (await applySave(entry.save, `Loaded “${entry.name}”.`)) markActive(entry);
  }
  function exportSave(id?: string) {
    saveNow();
    const entry = saves.find((s) => s.id === (id ?? activeSaveId));
    // The active save's name goes with what's on the desks now; another save goes as it was kept.
    downloadSave(id && entry ? entry.save : currentSave(entry?.name));
    setMessage(
      'Save exported. Import it here or in another browser to pick up where you left off.',
    );
  }
  const importFile = useRef<HTMLInputElement>(null);
  /** Load a save: its desks go to the server, its choices to this page. False when it failed. */
  async function applySave(save: SessionSave, note: string) {
    stopCamera();
    setBusy('restore');
    setError('');
    try {
      for (const m of ['demo', 'live'] as const) {
        await restoreDesk(save.desks[m] ?? emptyDesk(m));
        undo.current[m] = [];
        redo.current[m] = [];
      }
      setLastAiRun(null);
      const next = prefsOf(save.prefs);
      changeMode(next.mode);
      setWorkScene(next.workScene);
      setChoosingScene(false);
      setStageView(next.stageView);
      setSelection(null);
      setIsoPanel('room');
      setRuleDraft(null);
      setOverlay(next.overlay);
      setShowTrail(next.trail);
      setShowZones(next.zones);
      setShowPicture(next.picture);
      setShowCorner(next.corner);
      setFixtureLook(next.fixtureLook);
      setConcept(next.concept);
      if (next.demoPosition in DEMO_POSITIONS) setDemoPosition(next.demoPosition as DemoPosition);
      setCameraSource(next.cameraSource);
      setCameraWanted(next.cameraOn);
      setReopenTries(0);
      setTracking(next.tracking);
      setDrawer(next.drawer);
      setTool(next.tool);
      setIsoSurfaceId(next.isoSurfaceId || undefined);
      setOutlineOpen(next.outlineOpen);
      setLogKind(RUN_KINDS.includes(next.logKind as RunKind) ? (next.logKind as RunKind) : 'all');
      setLogMode(next.logMode as Mode | 'all');
      setFailuresOnly(next.failuresOnly);
      setPinning(null);
      setHistoryTick((t) => t + 1);
      setMessage(note);
      void refresh().catch(() => {});
      return true;
    } catch (e) {
      setError(e instanceof Error ? e : 'The save could not be loaded.');
      return false;
    } finally {
      setBusy('');
    }
  }
  /** Load a save file, and keep it among the named saves under its own name or the file's. */
  async function importSave(chosen: File) {
    try {
      const save = parseSave(await chosen.text());
      const taken = new Set(saves.map((s) => s.name.toLowerCase()));
      const base = save.name || saveName(chosen.name.replace(/\.json$/i, '')) || 'Imported save';
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = saveName(`${base} (${n})`);
      const entry: NamedSave = { id: crypto.randomUUID(), name, save: { ...save, name } };
      if (!(await applySave(save, `Imported “${name}”.`))) return;
      if (writeSaves(withSave(saves, entry))) {
        setSaves(withSave(saves, entry));
        markActive(entry);
      }
    } catch (e) {
      setError(e instanceof Error ? e : 'The save could not be read.');
    } finally {
      if (importFile.current) importFile.current.value = '';
    }
  }
  /** The autosave, and the named save in use if there is one. */
  function saveEverything() {
    if (!saveNow()) return setMessage('This browser would not store the save.');
    if (activeSave && updateSave(activeSave.id)) return setMessage(`Saved “${activeSave.name}”.`);
    setMessage('Saved to this browser. Name a save to keep a copy you can load again.');
  }
  /** Clear both desks and this browser's autosave, keeping named saves; the menu asks first, as embedded browsers block confirm(). */
  async function resetToDemo() {
    clearSession();
    markActive(null);
    await applySave(
      { app: 'livinglayer', version: 1, savedAt: new Date().toISOString(), prefs: {}, desks: {} },
      'Reset to the demo. Choose a room to begin.',
    );
  }
  return useStableSlice({
    activeSave,
    deleteSave,
    exportSave,
    importFile,
    importSave,
    loadSave,
    renameSave,
    resetToDemo,
    saveAs,
    saveEverything,
    saveNow,
    savedAt,
    saves,
    stepHistory,
    storageOk,
    unsaved,
    updateSave,
  });
}
export type SavesSlice = ReturnType<typeof useSavesSlice>;
