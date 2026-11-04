// Tokens and shared controls first: every screen's own styles come after and may refine them.
import './tokens.css';
import './ui/controls.css';
import './ui/surfaces.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Later } from './Later';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

// Each page loads only its own code: the playground doesn't bring the workspace, nor it the playground.
const Playground = lazy(() =>
  import('./playground/Playground').then((m) => ({ default: m.Playground })),
);
const App = lazy(() => import('./App').then((m) => ({ default: m.App })));
const Studio = lazy(() => import('./studio/Studio').then((m) => ({ default: m.Studio })));
// Development only: in a production build this and its styles are left out. `?recording`
// leaves it out too, so a take on the dev server never shows its reload card.
const recording = new URLSearchParams(window.location.search).has('recording');
const DevReload =
  import.meta.env.DEV && !recording
    ? lazy(() => import('./DevReload').then((m) => ({ default: m.DevReload })))
    : null;
const PAGES: Record<string, typeof App> = { '/playground': Playground, '/studio': Studio };
const Page = PAGES[window.location.pathname.replace(/\/$/, '')] ?? App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Later>
      <Page />
    </Later>
    {DevReload && (
      <Suspense fallback={null}>
        <DevReload />
      </Suspense>
    )}
  </StrictMode>,
);
