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
import type { SavesSlice } from './saves';

/** Every slice of the lab's state, by name. */
export interface LabSlices {
  view: ViewSlice;
  feedback: FeedbackSlice;
  runlog: RunLogSlice;
  desk: DeskSlice;
  followState: FollowStateSlice;
  camera: CameraSlice;
  observation: ObservationSlice;
  tracking: TrackingSlice;
  navigation: NavigationSlice;
  ai: AiSlice;
  fixtures: FixturesSlice;
  calibration: CalibrationSlice;
  probes: ProbesSlice;
  saves: SavesSlice;
}
/** The whole lab as one flat object: what `useLab()` gives. */
export type Lab = ViewSlice &
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
  ProbesSlice &
  SavesSlice;
