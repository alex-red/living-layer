import { type PointerEvent, useCallback, useMemo } from 'react';
import type { PlacementDecision, DeskObservation, UnitBox } from '@livinglayer/domain';
import { mainZone, mugHistory, mugOf, mugSighting } from '@livinglayer/domain';
import type { RunOf } from '@livinglayer/domain';
import { isRun } from '@livinglayer/domain';
import { zoneApplies } from '@livinglayer/domain';
import { sceneProgress } from '../progress';
import type { ViewSlice } from './view';
import type { FeedbackSlice } from './feedback';
import type { RunLogSlice } from './runlog';
import type { DeskSlice } from './desk';
import type { FollowStateSlice } from './follow-state';
import type { CameraSlice } from './camera';
import { useStableSlice } from './stable';
import type { Progress } from '../progress';
import type { Detection } from '@livinglayer/domain';

/** The Observation slice of the lab's state. */
export function useObservationSlice(
  deps: ViewSlice & FeedbackSlice & RunLogSlice & DeskSlice & FollowStateSlice & CameraSlice,
): ObservationSlice {
  const {
    busy,
    camera,
    cameraSize,
    draftZone,
    drawing,
    follow,
    image,
    memory,
    metaReady,
    mode,
    runs,
    segmentRunId,
    segmentation,
    workScene,
  } = deps;
  const seen = mugSighting(memory);
  const main = mainZone(memory);
  const currentObservation =
    seen && segmentation?.sourceKey === seen.sourceKey && segmentRunId === seen.segmentRunId
      ? seen
      : null;
  // Where a zone is drawn: the mug in this frame, or, on the running camera, its last sighting
  // from a frame the camera gives, since the stream shows that same view.
  const zoneObservation =
    currentObservation ??
    (camera &&
    seen &&
    seen.frame.width === cameraSize?.width &&
    seen.frame.height === cameraSize.height
      ? seen
      : null);
  const zone = useMemo(
    () => (memory && zoneObservation ? zoneApplies(memory) : null),
    [memory, zoneObservation],
  );
  // New frames from following only have a zone by the fixed-camera assumption.
  const localZone: UnitBox | null =
    main &&
    memory?.fixedCamera &&
    main.frame?.width === seen?.frame.width &&
    main.frame?.height === seen?.frame.height
      ? main.rect
      : null;
  const visibleZone = drawing ? draftZone : zone?.applies && main ? main.rect : null;
  // Where the mug has been, newest first, with the verdict each sighting got.
  const sightings = useMemo(() => {
    const last = mugSighting(memory);
    return last ? [last, ...mugHistory(memory)] : [];
  }, [memory]);
  const verdictFor = useCallback(
    (o: DeskObservation) =>
      runs.find(
        (r): r is RunOf<'placement'> => isRun(r, 'placement') && r.output.observationId === o.id,
      )?.output,
    [runs],
  );
  // Earlier boxes only line up with this frame when the frame is the same size.
  const trail = useMemo(
    () =>
      segmentation
        ? sightings.filter(
            (o) =>
              o.frame.width === segmentation.frame.width &&
              o.frame.height === segmentation.frame.height,
          )
        : [],
    [segmentation, sightings],
  );
  function zonePoint(e: PointerEvent<SVGSVGElement>) {
    const bounds = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height)),
    };
  }
  const canVision =
    Boolean(workScene) && !busy && (mode === 'demo' || (metaReady && (Boolean(image) || camera)));
  const canTrack =
    Boolean(workScene) &&
    !busy &&
    !follow &&
    Boolean(mugOf(memory) && mugSighting(memory)) &&
    (mode === 'demo' || (metaReady && (Boolean(image) || camera)));
  const confirmedId = currentObservation?.detectionId;
  const progress = useMemo(
    () => sceneProgress({ mode, workScene, memory }),
    [mode, workScene, memory],
  );
  const sorted = useMemo(
    () =>
      segmentation
        ? [...segmentation.detections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        : [],
    [segmentation],
  );
  return useStableSlice(
    {
      canTrack,
      canVision,
      confirmedId,
      currentObservation,
      localZone,
      progress,
      sightings,
      sorted,
      trail,
      verdictFor,
      visibleZone,
      zone,
      zoneObservation,
      zonePoint,
    },
    ['verdictFor'],
  );
}
/** What the Observation slice of the lab offers: its state, derived values and actions. */
export interface ObservationSlice {
  canTrack: boolean;
  canVision: boolean;
  confirmedId: string | undefined;
  currentObservation: DeskObservation | null;
  localZone: UnitBox | null;
  progress: Progress;
  sightings: DeskObservation[];
  sorted: Detection[];
  trail: DeskObservation[];
  verdictFor: (o: DeskObservation) => PlacementDecision | undefined;
  visibleZone: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  zone: {
    applies: boolean;
    carried: boolean;
  } | null;
  zoneObservation: DeskObservation | null;
  zonePoint: (e: PointerEvent<SVGSVGElement>) => {
    x: number;
    y: number;
  };
}
