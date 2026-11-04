import { useEffect, useRef, useState, useMemo } from 'react';
import type { Mode, RunKind, DemoPosition, StoredSave } from '@livinglayer/domain';
import { api, ApiError } from '../../api';
import { DEMO_POSITIONS } from '@livinglayer/domain';
import {
  clearSession,
  deskKeys,
  desksToSave,
  downloadSave,
  emptyDesk,
  mergeSaves,
  onOtherTabSave,
  parseSave,
  parseSaves,
  prefsOf,
  readSaves,
  readSession,
  readUi,
  saveName,
  withSave,
  writeSaves,
  writeSession,
  writeUi,
  type DeskKeys,
  type NamedSave,
  type Prefs,
  type SessionSave,
} from '../../session';
import { SHORTCUTS } from '../../shortcuts';
import { RUN_KINDS, deskJson, pushHistory } from './helpers';
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
import type { RefObject } from 'react';

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
): SavesSlice {
  const {
    boot,
    busy,
    camera,
    cameraFilter,
    cameraFilterKind,
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
    setCameraFilter,
    setCameraFilterKind,
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
    setShowStats,
    setShowPicture,
    setShowTrail,
    setShowZones,
    setStageView,
    setToolRaw: setTool,
    setTrackingRaw: setTracking,
    setWorkScene,
    showCorner,
    showStats,
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
  const prefs: Prefs = useMemo(
    () => ({
      mode,
      workScene,
      stageView,
      overlay,
      trail: showTrail,
      zones: showZones,
      picture: showPicture,
      corner: showCorner,
      stats: showStats,
      fixtureLook,
      cameraFilter,
      cameraFilterKind,
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
    }),
    [
      mode,
      workScene,
      stageView,
      overlay,
      showTrail,
      showZones,
      showPicture,
      showCorner,
      showStats,
      fixtureLook,
      cameraFilter,
      cameraFilterKind,
      concept,
      demoPosition,
      cameraSource,
      cameraWanted,
      tracking,
      drawer,
      tool,
      isoPanel,
      modelOf,
      isoSurfaceId,
      outlineOpen,
      logKind,
      logMode,
      failuresOnly,
    ],
  );
  // Other tabs share the autosave: this tab's desks as it last wrote or caught up to them, and its choices as last written.
  const seenDesks = useRef<Partial<DeskKeys>>({});
  const writtenPrefs = useRef('');
  /** Write the autosave; unless `always`, only when this tab changed something since it last did. */
  /**
   * The desks the autosave holds, as this tab last wrote or read them; read
   * again only once another tab wrote it (a `storage` event) or at first.
   */
  const storedDesks = useRef<{ desks: SessionSave['desks'] | undefined } | null>(null);
  function saveNow(always = true) {
    const keys = ourDeskKeys();
    const prefsText = JSON.stringify(prefs);
    const changed =
      keys.demo !== seenDesks.current.demo ||
      keys.live !== seenDesks.current.live ||
      prefsText !== writtenPrefs.current;
    if (!always && !changed) return true;
    storedDesks.current ??= { desks: readSession()?.desks };
    // A desk this tab didn't change may be older than one another tab saved meanwhile: keep that one.
    const desks = desksToSave(memories, seenDesks.current, storedDesks.current.desks, keys);
    const ok = writeSession(prefs, desks);
    setStorageOk(ok);
    if (ok) {
      storedDesks.current = { desks };
      seenDesks.current = keys;
      writtenPrefs.current = prefsText;
      setSavedAt(new Date().toISOString());
    }
    return ok;
  }
  /** `deskKeys` of this tab's desks, each worked out once per desk. */
  function ourDeskKeys(): DeskKeys {
    const key = (m: Mode) => {
      const desk = memories[m];
      return desk ? deskJson(desk) : 'null';
    };
    return { demo: key('demo'), live: key('live') };
  }
  const saveLatest = useRef(saveNow);
  saveLatest.current = saveNow;
  useEffect(() => {
    if (!deskReady) return;
    const timer = window.setTimeout(() => saveLatest.current(false), 400);
    return () => window.clearTimeout(timer);
  }, [deskReady, memories, prefs]);
  // A reload or a closed tab can come sooner than the pause autosave waits for, so save on the way out too.
  const flush = useRef(() => {});
  flush.current = () => {
    if (deskReady) saveNow(false);
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
      to.current[mode] = pushHistory(to.current[mode], current);
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
  // Named saves: the server's, as this browser last synced them and with what it made meanwhile, and the one last saved or loaded.
  const [saves, setSaves] = useState<NamedSave[]>(readSaves);
  const [activeSaveId, setActiveSaveId] = useState(() => {
    const id = readUi('activeSave');
    return typeof id === 'string' ? id : '';
  });
  const activeSave = saves.find((s) => s.id === activeSaveId) ?? null;
  // When another tab saves desks other than this tab's, fetch them from the server, so this tab works on and saves the current ones.
  const catchUp = useRef(() => {});
  catchUp.current = () => {
    if (!deskReady) return;
    const stored = deskKeys(readSession()?.desks ?? {});
    const ours = ourDeskKeys();
    if (stored.demo === ours.demo && stored.live === ours.live) return;
    void refresh()
      .then((desks) => {
        seenDesks.current = deskKeys(desks);
      })
      .catch(() => {});
  };
  useEffect(() => {
    let timer = 0;
    const stop = onOtherTabSave((what) => {
      if (what === 'saves') return setSaves(readSaves());
      // What the autosave holds is another tab's now: read it again before writing.
      storedDesks.current = null;
      // Another tab autosaves at most every pause, but a burst of them needs one fetch.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => catchUp.current(), 200);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);
  /** Take the server's list as this browser's copy, keeping saves only here; answers those still to send. */
  function adopt(server: StoredSave[]) {
    const { saves: merged, upload } = mergeSaves(readSaves(), parseSaves(JSON.stringify(server)));
    if (writeSaves(merged)) setSaves(merged);
    else setSaves(parseSaves(JSON.stringify(merged)));
    return upload;
  }
  /**
   * Send one save to the server. What it keeps may be another save's place
   * (the name was taken there): then this copy goes, and the active save follows.
   */
  async function send(entry: NamedSave) {
    const { save, saves: server } = await api('saves/save', {
      id: entry.id,
      name: entry.name,
      save: entry.save,
    });
    // On the server now, so a copy left here without it was replaced there.
    writeSaves(readSaves().map((s) => (s.id === entry.id ? { ...s, onServer: true } : s)));
    adopt(server);
    if (save.id !== entry.id && readUi('activeSave') === entry.id) {
      setActiveSaveId(save.id);
      writeUi('activeSave', save.id);
    }
  }
  /** Whether the server took this browser's saves when last asked: `away` keeps them here only until it's back. */
  const [savesServer, setSavesServer] = useState<'checking' | 'shared' | 'away'>('checking');
  /** Bring this browser's saves and the server's together; a server that can't be reached leaves them as they are here. */
  const syncing = useRef(false);
  async function syncSaves() {
    if (syncing.current) return;
    syncing.current = true;
    try {
      for (const entry of adopt(await api('saves'))) await send(entry);
      setSavesServer('shared');
    } catch {
      // The server is away: this browser's copy serves until the next sync.
      setSavesServer('away');
    } finally {
      syncing.current = false;
    }
  }
  /** A change made here, sent on; one the server can't take now goes at the next sync. */
  function share(change: () => Promise<unknown>) {
    void change().then(
      () => setSavesServer('shared'),
      () => setSavesServer('away'),
    );
  }
  const syncLatest = useRef(syncSaves);
  syncLatest.current = syncSaves;
  useEffect(() => {
    void syncLatest.current();
    // Another device may have saved while this tab was hidden.
    const shown = () => {
      if (document.visibilityState === 'visible') void syncLatest.current();
    };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, []);
  const savedEdits = useRef(0);
  /** Whether there are edits no named save holds, so loading another would lose them. */
  const unsaved = !activeSave || edits.current !== savedEdits.current;
  function markActive(entry: NamedSave | null) {
    setActiveSaveId(entry?.id ?? '');
    writeUi('activeSave', entry?.id ?? '');
    savedEdits.current = edits.current;
  }
  // Each change starts from the list as stored, not this tab's copy, so it keeps saves another tab made meanwhile.
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
    const stored = readSaves();
    const same = stored.find((s) => s.name.toLowerCase() === clean.toLowerCase());
    const entry: NamedSave = {
      id: same?.id ?? crypto.randomUUID(),
      name: clean,
      save: currentSave(clean),
    };
    if (!storeSaves(withSave(stored, entry))) return false;
    markActive(entry);
    share(() => send(entry));
    setMessage(same ? `Updated “${clean}”.` : `Saved as “${clean}”.`);
    return true;
  }
  /** Put what's on the desks into an existing named save. */
  function updateSave(id: string) {
    const stored = readSaves();
    const entry = stored.find((s) => s.id === id);
    if (!entry) return false;
    saveNow();
    const next = { ...entry, save: currentSave(entry.name) };
    if (!storeSaves(withSave(stored, next))) return false;
    markActive(next);
    share(() => send(next));
    return true;
  }
  function renameSave(id: string, name: string) {
    const clean = saveName(name);
    const stored = readSaves();
    const entry = stored.find((s) => s.id === id);
    if (!clean || !entry) return false;
    const taken = stored.some((s) => s.id !== id && s.name.toLowerCase() === clean.toLowerCase());
    if (taken) {
      setError(`There is already a save called “${clean}”.`);
      return false;
    }
    if (
      !storeSaves(
        stored.map((s) =>
          s.id === id ? { ...s, name: clean, save: { ...s.save, name: clean } } : s,
        ),
      )
    )
      return false;
    // One only here gets its new name when it is sent; another device may have taken the name meanwhile.
    if (entry.onServer)
      void api('saves/rename', { id, name: clean })
        .then(adopt)
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.code === 'save_name_taken') {
            setError(e);
            void syncSaves();
          }
        });
    return true;
  }
  function deleteSave(id: string) {
    const stored = readSaves();
    const entry = stored.find((s) => s.id === id);
    if (!entry || !storeSaves(stored.filter((s) => s.id !== id))) return;
    if (entry.onServer) share(() => api('saves/delete', { id }).then(adopt));
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
      setShowStats(next.stats);
      setFixtureLook(next.fixtureLook);
      setCameraFilter(next.cameraFilter);
      setCameraFilterKind(next.cameraFilterKind);
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
      const taken = new Set(readSaves().map((s) => s.name.toLowerCase()));
      const base = save.name || saveName(chosen.name.replace(/\.json$/i, '')) || 'Imported save';
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = saveName(`${base} (${n})`);
      const entry: NamedSave = { id: crypto.randomUUID(), name, save: { ...save, name } };
      if (!(await applySave(save, `Imported “${name}”.`))) return;
      if (writeSaves(withSave(readSaves(), entry))) {
        setSaves(readSaves());
        markActive(entry);
      }
      share(() => send(entry));
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
    storedDesks.current = null;
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
    savesServer,
    stepHistory,
    storageOk,
    unsaved,
    updateSave,
  });
}
/** What the Saves slice of the lab offers: its state, derived values and actions. */
export interface SavesSlice {
  activeSave: NamedSave | null;
  deleteSave: (id: string) => void;
  exportSave: (id?: string) => void;
  importFile: RefObject<HTMLInputElement | null>;
  importSave: (chosen: File) => Promise<void>;
  loadSave: (id: string) => Promise<void>;
  renameSave: (id: string, name: string) => boolean;
  resetToDemo: () => Promise<void>;
  saveAs: (name: string) => boolean;
  saveEverything: () => void;
  saveNow: () => boolean;
  savedAt: string;
  saves: NamedSave[];
  savesServer: 'checking' | 'shared' | 'away';
  stepHistory: (back: boolean) => Promise<void>;
  storageOk: boolean;
  unsaved: boolean;
  updateSave: (id: string) => boolean;
}
