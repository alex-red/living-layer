import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './controls';

/**
 * A modal on the native `<dialog>`: it keeps focus inside, Escape and a click
 * on the backdrop close it, and focus goes back where it was. Mounted to open,
 * unmounted to close; `onClose` is how it asks.
 */
export function Dialog({
  title,
  label,
  className,
  onClose,
  children,
}: {
  title: string;
  /** Its accessible name when the title alone says too little. */
  label?: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={label ?? title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // The dialog itself is only the backdrop's area: its content sits in the body.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`modal-body ${className ?? ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <IconButton label="Close" onClick={onClose}>
            ×
          </IconButton>
        </div>
        {children}
      </div>
    </dialog>
  );
}
