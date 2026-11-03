import { useCallback } from 'react';
import type {
  EvidenceRun,
  Scene,
  Segmentation,
  LampResult,
  DeskMemory,
  PlacementDecision,
} from '@livinglayer/domain';
import { apiAt } from '../../api';
import { isProbe } from './helpers';
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
import { useStableSlice } from './stable';

/** The Probes slice of the lab's state. */
export function useProbesSlice(
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
    CalibrationSlice,
): ProbesSlice {
  const {
    busy,
    camera,
    concept,
    costNote,
    demoPosition,
    frameNow,
    image,
    lampReady,
    light,
    metaReady,
    mode,
    placementMessage,
    refresh,
    segmentation,
    setBusy,
    setConcept,
    setDrawing,
    setError,
    setLamp,
    setMemory,
    setMessage,
    setPinning,
    setScene,
    setSegmentRunId,
    setSegmentation,
    setSelected,
    setStageView,
    stopFollow,
  } = deps;
  async function execute(kind: 'text' | 'discover' | 'segment' | 'lamp', overrideConcept?: string) {
    // A running camera is looked at as it is now, not as it was last captured.
    const photo = ['discover', 'segment'].includes(kind) ? frameNow() : undefined;
    setBusy(kind);
    setError('');
    try {
      const run = await apiAt<EvidenceRun>(kind, {
        mode,
        ...(photo ? { imageDataUrl: photo } : {}),
        ...(kind === 'segment' ? { concept: overrideConcept ?? concept } : {}),
        ...(kind === 'segment' && mode === 'demo' ? { demoPosition } : {}),
      });
      if (kind === 'discover') setScene(run.output as Scene);
      if (kind === 'discover' || kind === 'segment') setLamp('off');
      if (kind === 'lamp' && (run.output as LampResult).stateConfirmed) light();
      if (kind === 'segment') {
        setSegmentation(run.output as Segmentation);
        setSegmentRunId(run.id);
        setDrawing(false);
      }
      setSelected(run);
      setMessage(
        kind === 'segment' && run.status === 'no_match'
          ? 'No match. The previous mask has been cleared.'
          : `${mode === 'demo' ? 'Demo' : 'Live'} ${kind} run saved ·${run.durationMs} ms${costNote(run)}.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e : 'Call failed.');
      if (kind === 'segment') setSegmentation(undefined);
      void refresh().catch(() => {});
    } finally {
      setBusy('');
    }
  }
  async function deskAction(
    path: 'select' | 'zone' | 'verify' | 'reset' | 'camera' | 'surface',
    fields: object = {},
  ) {
    setBusy(path);
    setError('');
    try {
      const result = await apiAt<DeskMemory | EvidenceRun<PlacementDecision>>(`desk/${path}`, {
        mode,
        ...fields,
      });
      if (path === 'verify') {
        const event = result as EvidenceRun<PlacementDecision>;
        setSelected(event);
        if (event.output.action === 'confirmed') light();
        setMessage(placementMessage(event));
      } else {
        setMemory(result as DeskMemory);
        if (path === 'reset') {
          setLamp('off');
          stopFollow();
        }
        const saved = result as DeskMemory;
        setMessage(
          path === 'select'
            ? 'Mug identity manually confirmed. Track it, then draw its zone.'
            : path === 'zone'
              ? saved.fixedCamera
                ? 'Zone saved. The camera is marked fixed, so it carries over to new frames of this size.'
                : 'Zone saved for this exact image. Review it before verifying placement.'
              : path === 'camera'
                ? saved.fixedCamera
                  ? 'Camera marked fixed. The zone now carries over to new frames of the same size.'
                  : 'Camera no longer marked fixed. A zone applies only to the image it was drawn on.'
                : path === 'surface'
                  ? saved.surface
                    ? 'Surface pinned. The iso view places the mug on it for frames of this size.'
                    : 'Surface pin cleared.'
                  : 'Desk memory reset. Evidence and action deduplication are retained.',
        );
        if (path === 'surface') {
          setPinning(null);
          setStageView('iso');
        }
        setDrawing(false);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e : 'Desk operation failed.');
    } finally {
      setBusy('');
    }
  }
  /** Why a saved probe can't be repeated right now, or null if it can. */
  const rerunBlock = useCallback(
    (run: EvidenceRun): string | null => {
      if (!isProbe(run.kind))
        return 'Only model and lamp calls can be repeated. Use the inspector for scene steps.';
      if (run.mode !== mode) return `Switch to ${run.mode} mode to repeat this run.`;
      if (busy) return 'Wait for the current call to finish.';
      if (camera) return 'Capture or stop the camera first.';
      if (run.kind === 'lamp')
        return mode === 'live' && !lampReady ? 'The lamp is not set up.' : null;
      if (mode === 'live' && !metaReady) return 'Live Meta calls are not available.';
      if (run.kind !== 'text' && mode === 'live' && !image) return 'Add a desk photo first.';
      return null;
    },
    [mode, busy, camera, lampReady, metaReady, image],
  );
  function rerun(run: EvidenceRun) {
    if (!isProbe(run.kind) || rerunBlock(run)) return;
    const again = run.kind === 'segment' ? (run.output as Segmentation).concept : undefined;
    if (again) setConcept(again);
    void execute(run.kind, again);
  }
  /**
   * A saved mask can go back on the scene when it was made from the image on
   * screen now: always for the demo, and for a live photo when its source
   * hash matches the mask already showing.
   */
  const canRestore = useCallback(
    (run: EvidenceRun): boolean => {
      if (busy || camera || run.mode !== mode || run.status === 'failed') return false;
      if (run.kind === 'discover') return mode === 'demo';
      if (run.kind !== 'segment') return false;
      const key = (run.output as Segmentation).sourceKey;
      return mode === 'demo' || (Boolean(key) && key === segmentation?.sourceKey);
    },
    [busy, camera, mode, segmentation?.sourceKey],
  );
  function restore(run: EvidenceRun) {
    if (run.kind === 'discover') {
      setScene(run.output as Scene);
      setMessage('Saved discovery restored to the scene.');
      return;
    }
    const restored = run.output as Segmentation;
    setSegmentation(restored);
    setSegmentRunId(run.id);
    setConcept(restored.concept);
    setDrawing(false);
    setLamp('off');
    setMessage(`Mask from run ${run.id.slice(0, 8)} restored. You can confirm it as before.`);
  }
  return useStableSlice(
    {
      canRestore,
      deskAction,
      execute,
      rerun,
      rerunBlock,
      restore,
    },
    ['rerunBlock', 'canRestore'],
  );
}
/** What the Probes slice of the lab offers: its state, derived values and actions. */
export interface ProbesSlice {
  canRestore: (run: EvidenceRun) => boolean;
  deskAction: (
    path: 'select' | 'zone' | 'verify' | 'reset' | 'camera' | 'surface',
    fields?: object,
  ) => Promise<void>;
  execute: (
    kind: 'text' | 'discover' | 'segment' | 'lamp',
    overrideConcept?: string,
  ) => Promise<void>;
  rerun: (run: EvidenceRun) => void;
  rerunBlock: (run: EvidenceRun) => string | null;
  restore: (run: EvidenceRun) => void;
}
