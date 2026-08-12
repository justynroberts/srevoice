import { motion } from 'framer-motion';
import type { Activity } from '../hooks/useSreConversation';

interface Props {
  activity: Activity;
  muted: boolean;
  name: string;
}

const COPY: Record<Activity, { label: string; sub: string }> = {
  offline: { label: 'Offline', sub: 'not connected' },
  connecting: { label: 'Waking up', sub: 'one moment' },
  listening: { label: 'Listening', sub: 'go ahead' },
  thinking: { label: 'Thinking', sub: 'looking that up' },
  speaking: { label: 'Speaking', sub: 'listen up' },
};

/**
 * The one always-visible answer to "is she hearing me, working, or talking?" —
 * the question you cannot resolve from a transcript that lags the audio.
 * Each state gets its own motion so it reads at a glance without the label.
 */
export function VoiceOrb({ activity, muted, name }: Props) {
  const live = activity !== 'offline' && activity !== 'connecting';
  const copy = muted && live ? { label: 'Muted', sub: 'she can’t hear you' } : COPY[activity];

  const tone = muted && live ? 'warn' : activity === 'offline' ? 'faint' : 'accent';
  const core =
    tone === 'warn' ? 'bg-warn' : tone === 'faint' ? 'bg-line-strong' : 'bg-accent';
  const ring =
    tone === 'warn' ? 'border-warn/50' : tone === 'faint' ? 'border-line-strong' : 'border-accent/60';

  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-10 w-10 items-center justify-center">
        {/* Speaking: an outward pulse, in time with speech. */}
        {activity === 'speaking' && !muted && (
          <motion.span
            className="absolute inset-0 rounded-full border border-accent/40"
            animate={{ scale: [1, 1.4, 1], opacity: [0.75, 0, 0.75] }}
            transition={{ duration: 1.05, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        {/* Listening: a slow, patient breath. */}
        {activity === 'listening' && !muted && (
          <motion.span
            className="absolute inset-0 rounded-full border border-accent/30"
            animate={{ scale: [1, 1.14, 1], opacity: [0.4, 0.12, 0.4] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        {/* Thinking: three dots orbiting — busy, but unhurried. */}
        {activity === 'thinking' && (
          <motion.span
            className="absolute inset-0"
            animate={{ rotate: 360 }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
          >
            {[0, 120, 240].map((deg) => (
              <span
                key={deg}
                className="absolute left-1/2 top-1/2 h-1 w-1 rounded-full bg-accent"
                style={{ transform: `rotate(${deg}deg) translateY(-15px)` }}
              />
            ))}
          </motion.span>
        )}

        <motion.span
          className={`absolute inset-1.5 rounded-full border-2 ${ring}`}
          animate={activity === 'connecting' ? { rotate: 360 } : { rotate: 0 }}
          transition={
            activity === 'connecting'
              ? { duration: 1.4, repeat: Infinity, ease: 'linear' }
              : { duration: 0.2 }
          }
          style={activity === 'connecting' ? { borderTopColor: 'transparent' } : undefined}
        />

        <motion.span
          className={`h-2.5 w-2.5 rounded-full ${core}`}
          animate={
            activity === 'speaking' && !muted
              ? { scale: [1, 1.5, 1] }
              : activity === 'thinking'
                ? { scale: [1, 0.72, 1], opacity: [1, 0.55, 1] }
                : { scale: 1, opacity: 1 }
          }
          transition={{
            duration: activity === 'thinking' ? 1.5 : 0.55,
            repeat: activity === 'speaking' || activity === 'thinking' ? Infinity : 0,
            ease: 'easeInOut',
          }}
        />
      </div>

      <div className="leading-tight">
        <p className="text-[13px] font-medium text-ink">
          {name}
          <span className="ml-1.5 font-normal text-ink-dim">· {copy.label}</span>
        </p>
        <p className="text-[11px] text-ink-faint">{copy.sub}</p>
      </div>
    </div>
  );
}
