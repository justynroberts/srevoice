import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type { Activity } from '../hooks/useSreConversation';
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

const STATE_FILE: Record<Activity, string> = {
  offline: 'offline',
  connecting: 'thinking',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
};

/** Resolves the first extension that actually loads, once per state. */
function useAvatarSource(state: string): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);

    const tryNext = (i: number) => {
      if (cancelled || i >= EXTENSIONS.length) return;
      const candidate = `/avatars/${state}.${EXTENSIONS[i]}`;
      const img = new Image();
      img.onload = () => {
        if (!cancelled) setSrc(candidate);
      };
      img.onerror = () => tryNext(i + 1);
      img.src = candidate;
    };
    tryNext(0);

    return () => {
      cancelled = true;
    };
  }, [state]);

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
  const file = STATE_FILE[activity];
  const src = useAvatarSource(file);

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
      <div className="relative h-14 w-14 shrink-0">
        {/* A ring echoes the state for anyone whose artwork is a still image. */}
        <motion.span
          className={`absolute -inset-1 rounded-full border-2 ${
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
            className="h-14 w-14 rounded-full object-cover"
          />
        </AnimatePresence>
      </div>

      <div className="leading-tight">
        <p className="text-[14px] font-semibold text-ink">{name}</p>
        <p className="text-[11px] text-ink-dim">{caption}</p>
      </div>
    </div>
  );
}

const CAPTION: Record<Activity, string> = {
  offline: 'Offline',
  connecting: 'Waking up…',
  listening: 'Listening',
  thinking: 'Looking that up…',
  speaking: 'Speaking',
};
