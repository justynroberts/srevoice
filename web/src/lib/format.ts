/** Incident work is relative-time work — nobody reads an ISO string under pressure. */
export function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((Date.now() - then) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  const [value, unit] =
    abs < 60 ? [abs, 's'] :
    abs < 3600 ? [Math.round(abs / 60), 'm'] :
    abs < 86_400 ? [Math.round(abs / 3600), 'h'] :
    [Math.round(abs / 86_400), 'd'];

  return future ? `in ${value}${unit}` : `${value}${unit} ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type Tone = 'critical' | 'warn' | 'ok' | 'info' | 'neutral';

const STATUS_TONES: Record<string, Tone> = {
  triggered: 'critical',
  acknowledged: 'warn',
  resolved: 'ok',
  high: 'critical',
  low: 'info',
  active: 'ok',
  disabled: 'neutral',
  warning: 'warn',
  critical: 'critical',
  error: 'critical',
  ok: 'ok',
};

export function toneFor(value: string | undefined): Tone {
  if (!value) return 'neutral';
  return STATUS_TONES[value.toLowerCase()] ?? 'neutral';
}

export const TONE_CLASSES: Record<Tone, string> = {
  critical: 'bg-critical/12 text-critical border-critical/30',
  warn: 'bg-warn/12 text-warn border-warn/30',
  ok: 'bg-ok/12 text-ok border-ok/30',
  info: 'bg-info/12 text-info border-info/30',
  neutral: 'bg-hover text-ink-dim border-line',
};

/** `pd__list_incidents` reads badly on screen; "list incidents" reads fine. */
export function humaniseToolName(qualified: string): { server: string; action: string } {
  const idx = qualified.indexOf('__');
  if (idx <= 0) return { server: '', action: qualified.replace(/_/g, ' ') };
  return {
    server: qualified.slice(0, idx),
    action: qualified.slice(idx + 2).replace(/_/g, ' '),
  };
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
