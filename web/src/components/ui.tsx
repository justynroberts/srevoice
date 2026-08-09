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

type ButtonTone = 'primary' | 'ghost' | 'danger';

const BUTTON_TONES: Record<ButtonTone, string> = {
  primary: 'bg-accent text-void hover:bg-accent-dim disabled:hover:bg-accent',
  ghost: 'border border-line text-ink-dim hover:border-line-strong hover:text-ink',
  danger: 'border border-critical/40 text-critical hover:bg-critical/10',
};

export function Button({
  tone = 'ghost',
  loading,
  children,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_TONES[tone]} ${className}`}
    >
      {loading && (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
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
