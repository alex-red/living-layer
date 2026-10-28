import { ProviderActivity } from './ProviderUi';
import { ActivityDrawer } from './workspace/ActivityDrawer';
import { Canvas } from './workspace/Canvas';
import { Inspector } from './workspace/Inspector';
import { LabContext } from './workspace/LabContext';
import { Outline } from './workspace/Outline';
import { KeysDialog, TopBar } from './workspace/TopBar';
import { useLabState } from './workspace/useLabState';
import './workspace/workspace.css';

/**
 * The desk lab: an outline of the scene, the canvas, and an inspector for
 * whatever is selected, with every run in a drawer below. All state lives in
 * `useLabState`; the panes read it through `LabContext`.
 */
export function App() {
  const lab = useLabState();
  return (
    <LabContext.Provider value={lab}>
      <div className={`shell lamp-${lab.lamp}`}>
        <TopBar />
        <main className="workspace">
          <Outline />
          <Canvas />
          <Inspector />
        </main>
        <ActivityDrawer />
        <ProviderActivity />
        {lab.showKeys && <KeysDialog />}
      </div>
    </LabContext.Provider>
  );
}
