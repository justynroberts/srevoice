import type { Activity } from '../hooks/useSreConversation';
import { VoiceRing } from './Stage';

/**
 * Paige in the console header: a small version of the stage's ring, driven by
 * the same audio, so she looks the same at a desk as she does on the big screen.
 *
 * The ring is drawn as additive light, which only reads against dark, so it
 * sits in its own black disc whichever theme the console is in.
 */
export function Avatar({
  activity,
  muted,
  name,
  getOutputVolume,
  getInputVolume,
  getOutputFrequency,
}: {
  activity: Activity;
  muted: boolean;
  name: string;
  getOutputVolume: () => number;
  getInputVolume: () => number;
  getOutputFrequency: () => Uint8Array;
}) {
  const live = activity !== 'offline' && activity !== 'connecting';
  const caption = muted && live ? 'Muted' : CAPTION[activity];

  return (
    <div className="flex items-center gap-3.5">
      <div className="relative h-[5.5rem] w-[5.5rem] shrink-0 overflow-hidden rounded-full bg-black" aria-hidden>
        <VoiceRing
          activity={activity}
          muted={muted}
          getOutputVolume={getOutputVolume}
          getInputVolume={getInputVolume}
          getOutputFrequency={getOutputFrequency}
          radius={0.3}
          moteCount={28}
        />
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
