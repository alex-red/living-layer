import type { ReactNode } from 'react';
import { ProviderActivity } from './ProviderUi';
import { ActivityDrawer } from './workspace/ActivityDrawer';
import { AiTaskDialog } from './workspace/AiTaskDialog';
import { Canvas } from './workspace/Canvas';
import { Inspector } from './workspace/Inspector';
import { useDesk, useFeedback, useView } from './workspace/LabContext';
import { LabProvider } from './workspace/LabProvider';
import { Outline } from './workspace/Outline';
import { KeysDialog, TopBar } from './workspace/TopBar';
import './workspace/workspace.css';
import './workspace/shell.css';

/**
 * The workspace: an outline of the scene, the canvas, and an inspector for
 * whatever is selected, with every run in a drawer below. All state lives in
 * `useLabState`, run once by `LabProvider`; the panes read the slices they
 * need through the hooks in `LabContext`.
 */
export function App() {
  return (
    <LabProvider>
      <LampShell>
        <TopBar />
        <Workspace>
          <Outline />
          <Canvas />
          <Inspector />
        </Workspace>
        <ActivityDrawer />
        <ProviderActivity />
        <KeysWhenAsked />
        <AiTaskDialog />
      </LampShell>
    </LabProvider>
  );
}

/**
 * The three panes, held back until the server's desks have loaded, so the
 * first frame is the room and not an empty setup that flips a moment later.
 * If the API can't be reached they show, with the error in the top bar.
 */
function Workspace({ children }: { children: ReactNode }) {
  const { deskReady } = useDesk();
  const { error } = useFeedback();
  const loading = !deskReady && !error;
  return (
    <main className={`workspace${loading ? ' loading' : ''}`} aria-busy={loading}>
      {children}
    </main>
  );
}

/** The shell warms up with the lamp. Its children are passed in, so a lamp change redraws only this. */
function LampShell({ children }: { children: ReactNode }) {
  const { lamp } = useFeedback();
  return <div className={`shell lamp-${lamp}`}>{children}</div>;
}

function KeysWhenAsked() {
  const { showKeys } = useView();
  return showKeys ? <KeysDialog /> : null;
}
