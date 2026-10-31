// Tokens and shared controls first: every screen's own styles come after and may refine them.
import './tokens.css';
import './ui/controls.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Playground } from './playground/Playground';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

const page =
  window.location.pathname.replace(/\/$/, '') === '/playground' ? <Playground /> : <App />;

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
