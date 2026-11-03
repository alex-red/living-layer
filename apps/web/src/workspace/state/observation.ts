import { type PointerEvent, useCallback, useMemo } from 'react';
import type { PlacementDecision, DeskObservation, UnitBox } from '@livinglayer/domain';
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
  const currentObservation =
    memory?.observation &&
    segmentation?.sourceKey === memory.observation.sourceKey &&
    segmentRunId === memory.observation.segmentRunId
      ? memory.observation
      : null;
  // Where a zone is drawn: the mug in this frame, or, on the running camera, its last sighting
  // from a frame the camera gives, since the stream shows that same view.
  const zoneObservation =
    currentObservation ??
    (camera &&
    memory?.observation &&
    memory.observation.frame.width === cameraSize?.width &&
    memory.observation.frame.height === cameraSize.height
      ? memory.observation
      : null);
  const zone = useMemo(
    () => (memory && zoneObservation ? zoneApplies(memory) : null),
    [memory, zoneObservation],
  );
  // New frames from following only have a zone by the fixed-camera assumption.
  const localZone: UnitBox | null =
    memory?.zone &&
    memory.fixedCamera &&
    memory.zone.frame?.width === memory.observation?.frame.width &&
    memory.zone.frame?.height === memory.observation?.frame.height
      ? memory.zone.rect
      : null;
  const visibleZone = drawing ? draftZone : zone?.applies && memory?.zone ? memory.zone.rect : null;
  // Where the mug has been, newest first, with the verdict each sighting got.
  const sightings = useMemo(
    () => (memory?.observation ? [memory.observation, ...(memory.history ?? [])] : []),
    [memory],
  );
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
    Boolean(memory?.object && memory.observation) &&
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
