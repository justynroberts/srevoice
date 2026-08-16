import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type { Activity } from '../hooks/useSreConversation';
import { useTheme } from '../hooks/useTheme';
import { VoiceOrb } from './VoiceOrb';

/**
 * Per-state avatar art, loaded by convention from `/avatars/<state>.<ext>` so
 * new artwork is a file drop rather than a code change. Anything the browser
 * can render works, including animated GIF and WebP.
 *
 * Falls back to the animated orb per state, so a missing file degrades to
 * something that still communicates rather than to a broken image.
 */
const EXTENSIONS = ['webp', 'gif', 'png', 'jpg', 'svg'] as const;

/**
 * Each state names its own file, with a fallback for states that can
 * reasonably borrow another's art. That way a partial set still covers every
 * state before it falls back to the orb.
 */
const STATE_FILE: Record<Activity, string[]> = {
  offline: ['offline'],
  connecting: ['connecting', 'listening', 'thinking'],
  listening: ['listening'],
  thinking: ['thinking'],
  speaking: ['speaking'],
};

/**
 * Resolves the first name-and-extension pair that actually loads.
 *
 * Light-theme art is looked for first under `/avatars/light/` and falls through
 * to the default set, so a half-finished light set is not a broken image — each
 * state independently uses light art if it exists and the dark art if it does
 * not. Artwork is drawn against a background, and a portrait matted in near-white
 * sitting in a dark console reads as a bug rather than as a portrait.
 */
function useAvatarSource(names: string[], theme: 'light' | 'dark'): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const key = `${theme}:${names.join(',')}`;

  useEffect(() => {
    let cancelled = false;
    setSrc(null);

    const dirs = theme === 'light' ? ['light/', ''] : [''];
    const candidates = dirs.flatMap((dir) =>
      names.flatMap((n) => EXTENSIONS.map((ext) => `/avatars/${dir}${n}.${ext}`)),
    );
    const tryNext = (i: number) => {
      if (cancelled || i >= candidates.length) return;
      const img = new Image();
      img.onload = () => {
        if (!cancelled) setSrc(candidates[i]);
      };
      img.onerror = () => tryNext(i + 1);
      img.src = candidates[i];
    };
    tryNext(0);

    return () => {
      cancelled = true;
    };
    // `key` collapses the array identity so a new render does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return src;
}

export function Avatar({
  activity,
  muted,
  name,
}: {
  activity: Activity;
  muted: boolean;
  name: string;
}) {
  const { resolved } = useTheme();
  const src = useAvatarSource(STATE_FILE[activity], resolved);

  if (!src) {
    return (
      <div className="flex items-center gap-3">
        <VoiceOrb activity={activity} muted={muted} name={name} />
      </div>
    );
  }

  const live = activity !== 'offline' && activity !== 'connecting';
  const caption = muted && live ? 'Muted' : CAPTION[activity];

  return (
    <div className="flex items-center gap-3.5">
      <div className="relative h-[8.25rem] w-[8.25rem] shrink-0">
        {/* A ring echoes the state for anyone whose artwork is a still image. */}
        <motion.span
          className={`absolute -inset-2 rounded-full border-2 ${
            muted && live
              ? 'border-warn/50'
              : activity === 'offline'
                ? 'border-line'
                : 'border-accent/50'
          }`}
          animate={
            activity === 'speaking' && !muted
              ? { scale: [1, 1.08, 1], opacity: [0.8, 0.3, 0.8] }
              : activity === 'thinking'
                ? { rotate: 360 }
                : { scale: 1, opacity: 0.6 }
          }
          transition={
            activity === 'thinking'
              ? { duration: 2.6, repeat: Infinity, ease: 'linear' }
              : { duration: 1.05, repeat: activity === 'speaking' ? Infinity : 0, ease: 'easeInOut' }
          }
          style={activity === 'thinking' ? { borderTopColor: 'transparent' } : undefined}
        />

        <AnimatePresence mode="wait">
          <motion.img
            key={src}
            src={src}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="h-[8.25rem] w-[8.25rem] rounded-full object-cover"
          />
        </AnimatePresence>
      </div>

      <div className="leading-tight">
        <p className="text-[17px] font-semibold text-ink">{name}</p>
        <p className="text-[13px] text-ink-dim">{caption}</p>
      </div>
    </div>
  );
}

const CAPTION: Record<Activity, string> = {
  // Idle, not broken. "Offline" reads as a fault to anyone who has not been
  // told the session has to be started.
  offline: 'Ready to help — click Start session to begin',
  connecting: 'Waking up…',
  listening: 'Listening',
  thinking: 'Looking that up…',
  speaking: 'Speaking',
};
