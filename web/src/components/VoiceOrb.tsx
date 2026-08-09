import { motion } from 'framer-motion';
import type { SessionPhase } from '../hooks/useSreConversation';

interface Props {
  phase: SessionPhase;
  isSpeaking: boolean;
  muted: boolean;
}

/**
 * The one always-visible answer to "is it hearing me, or talking?" — the
 * question you cannot resolve from a transcript that lags behind the audio.
 */
export function VoiceOrb({ phase, isSpeaking, muted }: Props) {
  const live = phase === 'live';
  const busy = phase === 'connecting' || phase === 'requesting-mic';

  const label = !live
    ? busy
      ? 'Connecting'
      : 'Offline'
    : muted
      ? 'Muted'
      : isSpeaking
        ? 'Speaking'
        : 'Listening';

  const ring = !live ? 'border-line-strong' : muted ? 'border-warn/50' : 'border-accent/60';
  const core = !live ? 'bg-line-strong' : muted ? 'bg-warn' : 'bg-accent';

  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-9 w-9 items-center justify-center">
        {live && !muted && (
          <motion.span
            className="absolute inset-0 rounded-full border border-accent/40"
            animate={
              isSpeaking
                ? { scale: [1, 1.35, 1], opacity: [0.7, 0, 0.7] }
                : { scale: [1, 1.12, 1], opacity: [0.35, 0.1, 0.35] }
            }
            transition={{ duration: isSpeaking ? 1.1 : 2.6, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
        <motion.span
          className={`absolute inset-1 rounded-full border-2 ${ring}`}
          animate={busy ? { rotate: 360 } : { rotate: 0 }}
          transition={busy ? { duration: 1.4, repeat: Infinity, ease: 'linear' } : { duration: 0.2 }}
          style={busy ? { borderTopColor: 'transparent' } : undefined}
        />
        <motion.span
          className={`h-2.5 w-2.5 rounded-full ${core}`}
          animate={live && isSpeaking ? { scale: [1, 1.5, 1] } : { scale: 1 }}
          transition={{ duration: 0.55, repeat: isSpeaking ? Infinity : 0, ease: 'easeInOut' }}
        />
      </div>

      <div className="leading-tight">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        <p className="font-mono-tight text-[10px] uppercase tracking-wider text-ink-faint">
          {live ? 'session live' : busy ? 'please wait' : 'not connected'}
        </p>
      </div>
    </div>
  );
}
