import { createContext, useContext, useRef, type Context } from 'react';
import type { LabSlices } from './state/lab';

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

/**
 * The lab's few calls a request needs that never change identity, and the
 * mode read when the call is made: a pane that makes requests renders for
 * none of the slices they come from.
 */
export interface LabCalls {
  /** The mode shown now, read at the moment of the call. */
  mode: () => LabSlices['view']['mode'];
  refresh: LabSlices['desk']['refresh'];
  setError: LabSlices['feedback']['setError'];
}
export const LabCallsContext = createContext<LabCalls | null>(null);
/** The lab's fixed calls (`LabCalls`). */
export function useLabCalls(): LabCalls {
  const calls = useContext(LabCallsContext);
  if (!calls) throw new Error('The lab hooks must be used inside the lab workspace.');
  return calls;
}

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

type Merged<T extends object[]> = T extends [infer A extends object, ...infer R extends object[]]
  ? A & Merged<R>
  : unknown;

/**
 * Several slices as one flat object, for a pane that reads fields from each.
 * It is the same object while none of its slices has changed, so the pane
 * renders only for a change in a slice it names.
 */
export function useLabParts<T extends object[]>(...parts: T): Merged<T> {
  const last = useRef<{ parts: T; merged: Merged<T> } | null>(null);
  const kept = last.current;
  if (kept && kept.parts.length === parts.length && kept.parts.every((p, i) => p === parts[i]))
    return kept.merged;
  const merged = Object.assign({}, ...parts) as Merged<T>;
  last.current = { parts, merged };
  return merged;
}
