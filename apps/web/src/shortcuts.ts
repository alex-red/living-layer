import { useEffect, useRef } from 'react';

export type ShortcutAction =
  | 'undo'
  | 'redo'
  | 'save'
  | 'export'
  | 'import'
  | 'photo'
  | 'iso'
  | 'scene'
  | 'select'
  | 'scale'
  | 'hand'
  | 'brush'
  | 'escape'
  | 'delete'
  | 'help';

const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl';

/** Every workspace shortcut, in the order the help lists them. */
export const SHORTCUTS: { action: ShortcutAction; keys: string; label: string }[] = [
  { action: 'undo', keys: `${MOD} Z`, label: 'Undo the last desk edit' },
  { action: 'redo', keys: MAC ? '⌘ ⇧ Z' : 'Ctrl Y', label: 'Redo' },
  { action: 'save', keys: `${MOD} S`, label: 'Save to this browser now' },
  { action: 'export', keys: MAC ? '⌘ ⇧ S' : 'Ctrl Shift S', label: 'Export a save file' },
  { action: 'import', keys: `${MOD} O`, label: 'Import a save file' },
  { action: 'photo', keys: 'P', label: 'Photo view' },
  { action: 'iso', keys: 'I', label: 'Iso view' },
  { action: 'scene', keys: 'C', label: 'Change the scene' },
  { action: 'select', keys: 'V', label: 'Select and move fixtures' },
  { action: 'scale', keys: 'S', label: 'Scale a fixture’s base' },
  { action: 'hand', keys: 'H', label: 'Pan the view' },
  { action: 'brush', keys: 'B', label: 'AI brush: select a thing and say what to do' },
  { action: 'delete', keys: 'Delete', label: 'Delete the selected fixture (undo brings it back)' },
  { action: 'escape', keys: 'Esc', label: 'Cancel a pin, a zone, a selection or the scene picker' },
  { action: 'help', keys: '?', label: 'Show these shortcuts' },
];

/** Typing in a field keeps its own keys, undo included. */
export function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return Boolean(
    el &&
    (el.isContentEditable ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      (el.tagName === 'INPUT' &&
        !['checkbox', 'radio', 'button', 'range'].includes((el as HTMLInputElement).type))),
  );
}
/** Which action a key press asks for, if any. */
function shortcutFor(e: KeyboardEvent): ShortcutAction | null {
  const mod = MAC ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey) {
    // Saving works from a field too, so the browser's own save dialog never opens.
    if (key === 's') return e.shiftKey ? 'export' : 'save';
    if (typing(e.target)) return null;
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && !MAC) return 'redo';
    if (key === 'o') return 'import';
    return null;
  }
  if (e.key === 'Escape') return 'escape';
  if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return null;
  // Some keyboards (and synthetic events) report Shift+/ rather than '?'.
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) return 'help';
  if (e.shiftKey) return null;
  if (e.key === 'Delete' || e.key === 'Backspace') return 'delete';
  const plain: Record<string, ShortcutAction> = {
    p: 'photo',
    i: 'iso',
    c: 'scene',
    v: 'select',
    s: 'scale',
    h: 'hand',
    b: 'brush',
  };
  return plain[key] ?? null;
}

/** Calls `run` for each workspace shortcut; it returns false to let the key through. */
export function useShortcuts(run: (action: ShortcutAction) => boolean | void) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat && e.key !== 'z') return;
      const action = shortcutFor(e);
      if (action && latest.current(action) !== false) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
