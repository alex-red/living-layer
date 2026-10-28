import { useEffect, useState, type ReactNode } from 'react';

/** A panel that drops from a button and closes on a click outside it. */
export function Popover({
  label,
  button,
  className,
  children,
}: {
  label: string;
  button: (open: boolean, toggle: () => void) => ReactNode;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  return (
    <span className="popover-anchor">
      {button(open, () => setOpen((v) => !v))}
      {open && (
        <>
          <span className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className={`popover ${className ?? ''}`} role="dialog" aria-label={label}>
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </span>
  );
}
