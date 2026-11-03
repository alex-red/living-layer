import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Drawn in the warning colour: it deletes something. */
  destructive?: boolean;
  disabled?: boolean;
  /** A line above it, to set it apart from the items before. */
  separated?: boolean;
}

/**
 * A right-click menu at the pointer, kept inside the window. It takes focus
 * on its first item, moves with the arrow keys, and closes on a choice, a
 * click outside, Escape, Tab, scrolling or resizing; focus goes back to
 * what opened it. It is drawn on the body: a pane's backdrop filter would
 * otherwise hold it in that pane's stacking and clip it to the pane.
 */
export function ContextMenu({
  at,
  items,
  label,
  onClose,
}: {
  at: { x: number; y: number };
  items: MenuItem[];
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);
  const opener = useRef(document.activeElement as HTMLElement | null);
  // Read through a ref: a caller's new `onClose` each render mustn't re-add the listeners or
  // move the focus back to the first item.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = () => {
    closeRef.current();
    opener.current?.focus?.();
  };
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const gap = 8;
    setPlace({
      x: Math.max(gap, Math.min(at.x, window.innerWidth - box.width - gap)),
      y: Math.max(gap, Math.min(at.y, window.innerHeight - box.height - gap)),
    });
  }, [at.x, at.y]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current();
    };
    const away = () => closeRef.current();
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    document.addEventListener('scroll', away, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
      document.removeEventListener('scroll', away, true);
    };
  }, []);
  function onKeyDown(e: KeyboardEvent) {
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => {
      e.preventDefault();
      buttons[(i + buttons.length) % buttons.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(buttons.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ left: place.x, top: place.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={`${item.destructive ? 'destructive' : ''} ${item.separated ? 'separated' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            close();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
