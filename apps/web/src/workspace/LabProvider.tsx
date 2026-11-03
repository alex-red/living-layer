import type { ReactNode } from 'react';
import { SliceContexts } from './LabContext';
import { useLabState } from './useLabState';

/** Runs the lab's state once and offers each slice to the panes below, which `children` hold. */
export function LabProvider({ children }: { children: ReactNode }) {
  const lab = useLabState();
  return (
    <SliceContexts.view.Provider value={lab.view}>
      <SliceContexts.feedback.Provider value={lab.feedback}>
        <SliceContexts.runlog.Provider value={lab.runlog}>
          <SliceContexts.desk.Provider value={lab.desk}>
            <SliceContexts.followState.Provider value={lab.followState}>
              <SliceContexts.camera.Provider value={lab.camera}>
                <SliceContexts.observation.Provider value={lab.observation}>
                  <SliceContexts.tracking.Provider value={lab.tracking}>
                    <SliceContexts.navigation.Provider value={lab.navigation}>
                      <SliceContexts.ai.Provider value={lab.ai}>
                        <SliceContexts.fixtures.Provider value={lab.fixtures}>
                          <SliceContexts.calibration.Provider value={lab.calibration}>
                            <SliceContexts.probes.Provider value={lab.probes}>
                              <SliceContexts.saves.Provider value={lab.saves}>
                                {children}
                              </SliceContexts.saves.Provider>
                            </SliceContexts.probes.Provider>
                          </SliceContexts.calibration.Provider>
                        </SliceContexts.fixtures.Provider>
                      </SliceContexts.ai.Provider>
                    </SliceContexts.navigation.Provider>
                  </SliceContexts.tracking.Provider>
                </SliceContexts.observation.Provider>
              </SliceContexts.camera.Provider>
            </SliceContexts.followState.Provider>
          </SliceContexts.desk.Provider>
        </SliceContexts.runlog.Provider>
      </SliceContexts.feedback.Provider>
    </SliceContexts.view.Provider>
  );
}
