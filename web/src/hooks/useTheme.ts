import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'srevoice.theme';

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function storedChoice(): ThemeChoice {
  const raw = localStorage.getItem(KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/** Applied before first paint by the inline script in index.html, and here on change. */
export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

/**
 * Three-way theme choice: follow the system, or pin light or dark.
 *
 * "System" is the default and stays live — an operator whose machine switches
 * at dusk gets the same from the console, without having chosen anything.
 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() => storedChoice());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    storedChoice() === 'system' ? systemTheme() : (storedChoice() as ResolvedTheme),
  );

  useEffect(() => {
    const next = choice === 'system' ? systemTheme() : choice;
    setResolved(next);
    applyTheme(next);
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  }, [choice]);

  // Keep following the system while that is the choice.
  useEffect(() => {
    if (choice !== 'system') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      const next = systemTheme();
      setResolved(next);
      applyTheme(next);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [choice]);

  /** Cycles light → dark → system, so every option is reachable from one control. */
  const cycle = useCallback(() => {
    setChoice((c) => (c === 'light' ? 'dark' : c === 'dark' ? 'system' : 'light'));
  }, []);

  return { choice, resolved, setChoice, cycle };
}
