// Tokens and shared controls first: every screen's own styles come after and may refine them.
import './tokens.css';
import './ui/controls.css';
import './ui/surfaces.css';
import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DevReload } from './DevReload';
import { Later } from './Later';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

const Playground = lazy(() =>
  import('./playground/Playground').then((m) => ({ default: m.Playground })),
);
const page =
  window.location.pathname.replace(/\/$/, '') === '/playground' ? (
    <Later>
      <Playground />
    </Later>
  ) : (
    <App />
  );

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
    {import.meta.env.DEV && <DevReload />}
  </StrictMode>,
);
