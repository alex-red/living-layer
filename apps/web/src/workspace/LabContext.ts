import { createContext, useContext, useMemo, type Context } from 'react';
import type { Lab, LabSlices } from './state/lab';

/** One context per slice, so a pane re-renders only when the slices it reads change. */
export const SliceContexts = {
  view: createContext<LabSlices['view'] | null>(null),
  feedback: createContext<LabSlices['feedback'] | null>(null),
  runlog: createContext<LabSlices['runlog'] | null>(null),
  desk: createContext<LabSlices['desk'] | null>(null),
  followState: createContext<LabSlices['followState'] | null>(null),
  camera: createContext<LabSlices['camera'] | null>(null),
  observation: createContext<LabSlices['observation'] | null>(null),
  tracking: createContext<LabSlices['tracking'] | null>(null),
  navigation: createContext<LabSlices['navigation'] | null>(null),
  ai: createContext<LabSlices['ai'] | null>(null),
  fixtures: createContext<LabSlices['fixtures'] | null>(null),
  calibration: createContext<LabSlices['calibration'] | null>(null),
  probes: createContext<LabSlices['probes'] | null>(null),
  saves: createContext<LabSlices['saves'] | null>(null),
} satisfies { [K in keyof LabSlices]: Context<LabSlices[K] | null> };

function useSlice<K extends keyof LabSlices>(key: K): LabSlices[K] {
  const slice = useContext(SliceContexts[key] as Context<LabSlices[K] | null>);
  if (!slice) throw new Error('The lab hooks must be used inside the lab workspace.');
  return slice;
}
/** The view slice of the lab alone. */
export const useView = () => useSlice('view');
/** The feedback slice of the lab alone. */
export const useFeedback = () => useSlice('feedback');
/** The runlog slice of the lab alone. */
export const useRunLog = () => useSlice('runlog');
/** The desk slice of the lab alone. */
export const useDesk = () => useSlice('desk');
/** The followState slice of the lab alone. */
export const useFollowState = () => useSlice('followState');
/** The camera slice of the lab alone. */
export const useCamera = () => useSlice('camera');
/** The observation slice of the lab alone. */
export const useObservation = () => useSlice('observation');
/** The tracking slice of the lab alone. */
export const useTracking = () => useSlice('tracking');
/** The navigation slice of the lab alone. */
export const useNavigation = () => useSlice('navigation');
/** The ai slice of the lab alone. */
export const useAi = () => useSlice('ai');
/** The fixtures slice of the lab alone. */
export const useFixtures = () => useSlice('fixtures');
/** The calibration slice of the lab alone. */
export const useCalibration = () => useSlice('calibration');
/** The probes slice of the lab alone. */
export const useProbes = () => useSlice('probes');
/** The saves slice of the lab alone. */
export const useSaves = () => useSlice('saves');

/**
 * The whole lab as one flat object. It renders with every slice, so a pane
 * that needs only some of them reads those through the hooks above.
 */
export function useLab(): Lab {
  const view = useView();
  const feedback = useFeedback();
  const runlog = useRunLog();
  const desk = useDesk();
  const followState = useFollowState();
  const camera = useCamera();
  const observation = useObservation();
  const tracking = useTracking();
  const navigation = useNavigation();
  const ai = useAi();
  const fixtures = useFixtures();
  const calibration = useCalibration();
  const probes = useProbes();
  const saves = useSaves();
  return useMemo(
    () => ({
      ...view,
      ...feedback,
      ...runlog,
      ...desk,
      ...followState,
      ...camera,
      ...observation,
      ...tracking,
      ...navigation,
      ...ai,
      ...fixtures,
      ...calibration,
      ...probes,
      ...saves,
    }),
    [
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
    ],
  );
}
