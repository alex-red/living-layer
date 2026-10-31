import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

/**
 * The app's controls, one place for each: a screen picks a variant and a
 * size, never its own padding or height. The look is in controls.css.
 */

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

export type ButtonVariant = 'primary' | 'secondary' | 'physical' | 'ghost' | 'text' | 'danger';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Primary is the one main action of a step; ghost suits toolbars and rows; danger is text-only. */
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Fill the width of its container. */
  block?: boolean;
  /** Shown while the action runs, with the button disabled. */
  busy?: ReactNode;
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'primary',
  secondary: 'secondary',
  physical: 'physical',
  ghost: 'ghost',
  text: 'text-button',
  danger: 'text-button destructive',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  busy,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={cx(VARIANT_CLASS[variant], size === 'sm' && 'sm', block && 'block', className)}
      disabled={disabled || Boolean(busy)}
      aria-busy={busy ? true : undefined}
    >
      {busy || children}
    </button>
  );
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** What it does, for the tooltip and for screen readers. */
  label: string;
  children: ReactNode;
  size?: 'md' | 'sm';
  /** A visible frame, for an icon button standing alone rather than in a toolbar. */
  framed?: boolean;
};

export function IconButton({
  label,
  size = 'md',
  framed,
  className,
  title,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      className={cx('icon-button', size === 'sm' && 'sm', framed && 'framed', className)}
      aria-label={label}
      title={title ?? label}
    >
      {children}
    </button>
  );
}

/** A label over (or, inline, beside) its control, with an optional hint under it. */
export function Field({
  label,
  hint,
  inline,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  inline?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cx('ui-field', inline && 'inline', className)}>
      <span className="tiny">{label}</span>
      {children}
      {hint && !inline && <span className="micro">{hint}</span>}
    </label>
  );
}

export type Option<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

export function Select<T extends string>({
  value,
  options,
  onChange,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <select {...rest} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A whole number kept within its bounds as it is typed. */
export function NumberInput({
  value,
  min,
  max,
  onChange,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'> & {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) =>
        onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min))))
      }
    />
  );
}

/** A checkbox with its label, the whole row clickable. */
export function Check({
  checked,
  onChange,
  children,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange' | 'type'> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className={cx('ui-check', className)}>
      <input
        {...rest}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

/** A segmented switch: pick one of a few, with a thumb that slides to it. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  disabled,
}: {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  /** What the choice is, for screen readers. */
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const i = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  return (
    <div
      className={cx('segmented', className)}
      role="group"
      aria-label={label}
      style={{ '--n': options.length, '--i': i } as CSSProperties}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Controls in a row; anything in `end` sits at the right. */
export function Toolbar({
  label,
  end,
  className,
  children,
}: {
  label: string;
  end?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx('ui-toolbar', className)} role="toolbar" aria-label={label}>
      {children}
      {end && <span className="end">{end}</span>}
    </div>
  );
}
