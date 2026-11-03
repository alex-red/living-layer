import { useEffect } from 'react';
import { aiTaskStore } from './state/ai-task-store';
import { followHealth, followViewStore } from './state/follow-store';
import { takeHandoff } from '../handoff';
import { useShortcuts, type ShortcutAction } from '../shortcuts';
import { deskIsBlank } from './state/helpers';
import { useViewSlice } from './state/view';
import { useFeedbackSlice } from './state/feedback';
import { useRunLogSlice } from './state/runlog';
import { useDeskSlice } from './state/desk';
import { useFollowStateSlice } from './state/follow-state';
import { useCameraSlice } from './state/camera';
import { useObservationSlice } from './state/observation';
import { useTrackingSlice } from './state/tracking';
import { useNavigationSlice } from './state/navigation';
import { useAiSlice } from './state/ai';
import { useFixturesSlice } from './state/fixtures';
import { useCalibrationSlice } from './state/calibration';
import { useProbesSlice } from './state/probes';
import { useSavesSlice } from './state/saves';
import type { LabSlices } from './state/lab';

/** Runs every slice in order, each reading the ones before it, and returns them by name. */
export function useLabState(): LabSlices {
  const view = useViewSlice();
  const d0 = { ...view };
  const feedback = useFeedbackSlice(d0);
  const d1 = { ...d0, ...feedback };
  const runlog = useRunLogSlice(d1);
  const d2 = { ...d1, ...runlog };
  const desk = useDeskSlice(d2);
  const d3 = { ...d2, ...desk };
  const followState = useFollowStateSlice();
  const d4 = { ...d3, ...followState };
  const camera = useCameraSlice(d4);
  const d5 = { ...d4, ...camera };
  const observation = useObservationSlice(d5);
  const d6 = { ...d5, ...observation };
  const tracking = useTrackingSlice(d6);
  const d7 = { ...d6, ...tracking };
  const navigation = useNavigationSlice(d7);
  const d8 = { ...d7, ...navigation };
  const ai = useAiSlice(d8);
  const d9 = { ...d8, ...ai };
  const fixtures = useFixturesSlice(d9);
  const d10 = { ...d9, ...fixtures };
  const calibration = useCalibrationSlice(d10);
  const d11 = { ...d10, ...calibration };
  const probes = useProbesSlice(d11);
  const d12 = { ...d11, ...probes };
  const saves = useSavesSlice(d12);
  const d13 = { ...d12, ...saves };
  const {
    aiRun,
    boot,
    boxing,
    brush,
    busy,
    cameraGeneration,
    captureCanvas,
    changeMode,
    chooseTool,
    choosingScene,
    deleteFixtures,
    drawing,
    exportSave,
    importFile,
    isoPanel,
    mounted,
    outlineOpen,
    outlining,
    pinning,
    placing,
    refresh,
    releaseStream,
    restoreDesk,
    ruleDraft,
    saveEverything,
    select,
    selection,
    setBoxing,
    setChoosingScene,
    setDeskReady,
    setDrawing,
    setError,
    setIsoPanel,
    setMessage,
    setOutlineOpen,
    setOutlining,
    setPinning,
    setPlacing,
    setShowKeys,
    setStageView,
    setToolRaw: setTool,
    setZooming,
    showKeys,
    stepHistory,
    tool,
    workScene,
    zooming,
  } = d13;
  useShortcuts((action: ShortcutAction) => {
    if (action === 'help') return setShowKeys((v) => !v);
    if (action === 'escape') {
      if (showKeys) return setShowKeys(false);
      if (outlineOpen) return setOutlineOpen(false);
      if (pinning) return setPinning(null);
      if (drawing) return setDrawing(false);
      // A rule being changed goes back to its own panel.
      if (ruleDraft) return select(ruleDraft.id ? { kind: 'rule', id: ruleDraft.id } : null);
      if (placing) return setPlacing(null);
      if (boxing) return setBoxing(null);
      if (outlining) return setOutlining(null);
      if (zooming) return setZooming(null);
      if (isoPanel !== 'room') return setIsoPanel('room');
      if (choosingScene && workScene) return setChoosingScene(false);
      if (brush.escape()) return;
      if (tool !== 'select') return setTool('select');
      return false;
    }
    if (action === 'save') return saveEverything();
    if (action === 'export') return exportSave();
    if (action === 'import') return importFile.current?.click();
    if (action === 'undo' || action === 'redo') return void stepHistory(action === 'undo');
    if (action === 'photo' || action === 'iso') {
      if (pinning) return false;
      setStageView(action);
      setIsoPanel('room');
      return;
    }
    if (action === 'delete') {
      // The layout editor deletes its own selection.
      if (selection?.kind !== 'fixture' || busy || pinning || placing || isoPanel === 'scene')
        return false;
      return void deleteFixtures([selection.id]);
    }
    if (action === 'scene' && !busy && !pinning) setChoosingScene(true);
    if (action === 'select' || action === 'scale' || action === 'hand') setTool(action);
    if (action === 'brush') chooseTool('brush');
  });
  useEffect(() => {
    mounted.current = true;
    void refresh()
      .then(async (desks) => {
        // A fresh server (new data folder) takes this browser's copy of its desks.
        for (const m of ['demo', 'live'] as const) {
          const local = boot.save?.desks[m];
          if (local && !deskIsBlank(local) && deskIsBlank(desks[m]))
            await restoreDesk(local).catch(() => {});
        }
        setDeskReady(true);
      })
      .catch(() => setError('The local API is unavailable. Start both services with bun run dev.'));
    const handedOff = takeHandoff();
    if (handedOff) {
      changeMode('live');
      const frame = new Image();
      frame.onload = () => {
        if (!mounted.current) return;
        captureCanvas(frame, frame.naturalWidth, frame.naturalHeight);
        setMessage('Frame from the camera playground, prepared locally. Run a live step on it.');
      };
      frame.src = handedOff;
    }
    // Late answers are dropped from here on, and the camera is let go.
    const leave = () => {
      mounted.current = false;
      // A running AI call is stopped with the lab, not left to answer no one.
      aiRun.current?.abort.abort();
      followViewStore.set(null);
      followHealth.stop();
      aiTaskStore.set(null);
      cameraGeneration.current++;
      releaseStream();
    };
    return leave;
  }, [
    aiRun,
    boot,
    cameraGeneration,
    captureCanvas,
    changeMode,
    mounted,
    refresh,
    releaseStream,
    restoreDesk,
    setDeskReady,
    setError,
    setMessage,
  ]);
  return {
    view,
    feedback,
    runlog,
    desk,
    followState,
    camera,
    observation,
    tracking,
    navigation,
    ai,
    fixtures,
    calibration,
    probes,
    saves,
  };
}

export {
  BUSY,
  LOG_PAGE,
  RESULT_GLYPH,
  RUN_KINDS,
  TRANSITION,
  centre,
  isProbe,
  runDetail,
} from './state/helpers';
export type { AiTask } from './state/ai-task-store';
export type { Lab } from './state/lab';
