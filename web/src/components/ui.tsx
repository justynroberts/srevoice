import * as SliderPrimitive from '@radix-ui/react-slider';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';

const INPUT_BASE =
  'w-full rounded-lg border border-line bg-void px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint transition-colors hover:border-line-strong focus:border-accent focus:outline-none disabled:opacity-50';

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

export function TextInput({
  label,
  hint,
  mono,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; mono?: boolean }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input id={id} {...props} className={`${INPUT_BASE} ${mono ? 'font-mono-tight' : ''}`} />
    </Field>
  );
}

/**
 * Free-text field with suggestions. Used where a fixed dropdown would be a
 * liability — ElevenLabs' model lineup moves faster than this app ships, and a
 * stale hardcoded list would strand the operator on a value their account
 * rejects.
 */
export function Combo({
  label,
  hint,
  suggestions,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  suggestions: { value: string; label?: string }[];
}) {
  const id = useId();
  const listId = `${id}-options`;
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input id={id} list={listId} autoComplete="off" {...props} className={`${INPUT_BASE} font-mono-tight`} />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s.value} value={s.value} label={s.label} />
        ))}
      </datalist>
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <textarea id={id} {...props} className={`${INPUT_BASE} resize-y leading-relaxed`} />
    </Field>
  );
}

export function Select({
  label,
  hint,
  options,
  ...props
}: InputHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: ReactNode;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select
        id={id}
        {...(props as React.SelectHTMLAttributes<HTMLSelectElement>)}
        className={`${INPUT_BASE} appearance-none bg-[length:14px] bg-[right_0.75rem_center] bg-no-repeat pr-9`}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M4 6l4 4 4-4' stroke='%236b6b76' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-surface">
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  hint?: ReactNode;
}) {
  return (
    <Field
      label={label}
      hint={hint}
    >
      <div className="flex items-center gap-3">
        <SliderPrimitive.Root
          value={[value]}
          onValueChange={([v]) => onChange(v)}
          min={min}
          max={max}
          step={step}
          className="relative flex h-5 flex-1 touch-none select-none items-center"
          aria-label={label}
        >
          <SliderPrimitive.Track className="relative h-1 w-full grow rounded-full bg-line">
            <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb className="block h-3.5 w-3.5 rounded-full border-2 border-accent bg-void transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50" />
        </SliderPrimitive.Root>
        <span className="w-12 shrink-0 text-right font-mono-tight text-[12px] text-ink-dim">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
    </Field>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative h-5 w-9 shrink-0 rounded-full border border-line bg-hover transition-colors data-[state=checked]:border-accent/50 data-[state=checked]:bg-accent/25"
      >
        <SwitchPrimitive.Thumb className="block h-3.5 w-3.5 translate-x-1 rounded-full bg-ink-faint transition-transform data-[state=checked]:translate-x-[1.15rem] data-[state=checked]:bg-accent" />
      </SwitchPrimitive.Root>
      <span className="text-[12px] text-ink-dim">{label}</span>
    </label>
  );
}

/**
 * Inline rather than an icon package: there are a dozen of them, they need to
 * inherit `currentColor` to work in both themes, and a dependency for this
 * would ship a few thousand glyphs to render twelve.
 */
function Glyph({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={`h-[1.15rem] w-[1.15rem] shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const Icon = {
  play: () => (
    <Glyph>
      <path d="M6.5 4.2v11.6l9.3-5.8z" />
    </Glyph>
  ),
  stop: () => (
    <Glyph>
      <rect x="5" y="5" width="10" height="10" rx="2" />
    </Glyph>
  ),
  send: () => (
    <Glyph>
      <path d="M17 3.5 9 11M17 3.5l-5.2 13.8-2.9-6.2-6.2-2.9z" />
    </Glyph>
  ),
  clear: () => (
    <Glyph>
      <path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.7 10a1.5 1.5 0 0 0 1.5 1.4h4.6a1.5 1.5 0 0 0 1.5-1.4l.7-10" />
    </Glyph>
  ),
  settings: () => (
    <Glyph>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.4v1.9M10 15.7v1.9M17.6 10h-1.9M4.3 10H2.4M15.4 4.6l-1.3 1.3M5.9 14.1l-1.3 1.3M15.4 15.4l-1.3-1.3M5.9 5.9 4.6 4.6" />
    </Glyph>
  ),
  panel: () => (
    <Glyph>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M12 3.5v13" />
    </Glyph>
  ),
};

type ButtonTone = 'primary' | 'ghost' | 'danger';

const BUTTON_TONES: Record<ButtonTone, string> = {
  primary: 'bg-accent text-void hover:bg-accent-dim disabled:hover:bg-accent',
  ghost: 'border border-line text-ink-dim hover:border-line-strong hover:text-ink hover:bg-hover/50',
  danger: 'border border-critical/40 text-critical hover:bg-critical/10',
};

/**
 * Sized for a hand, not a cursor. `icon` is square so a glyph-only control
 * keeps a proper hit target instead of collapsing to the size of its svg.
 */
const BUTTON_SIZES = {
  md: 'min-h-[2.75rem] px-4 py-2.5 text-[14px]',
  icon: 'h-11 w-11 p-0',
} as const;

export function Button({
  tone = 'ghost',
  size = 'md',
  loading,
  children,
  className = '',
  ...props
  // `size` on InputHTMLAttributes is the numeric DOM attribute; intersecting
  // with it collapses this prop to `never`.
}: Omit<InputHTMLAttributes<HTMLButtonElement>, 'size'> & {
  tone?: ButtonTone;
  size?: keyof typeof BUTTON_SIZES;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      disabled={props.disabled || loading}
      className={`press inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-medium disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_SIZES[size]} ${BUTTON_TONES[tone]} ${className}`}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

export function Callout({ tone, children }: { tone: 'error' | 'warn' | 'ok' | 'info'; children: ReactNode }) {
  const styles = {
    error: 'border-critical/30 bg-critical/10 text-critical',
    warn: 'border-warn/30 bg-warn/10 text-warn',
    ok: 'border-ok/30 bg-ok/10 text-ok',
    info: 'border-info/30 bg-info/10 text-info',
  }[tone];

  return (
    <div className={`rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${styles}`}>{children}</div>
  );
}
