import { useEffect } from 'react';
import { useSreConversation, type SessionProblem } from '../hooks/useSreConversation';
import { enterBrowserFullscreen, Stage } from './Stage';

/**
 * Picks the phone view. `/m` forces it anywhere, which is how to try it on
 * a laptop; `?console` forces the full console on a phone.
 */
export function wantsPhoneView(): boolean {
  if (typeof window === 'undefined') return false;
  const { pathname, search } = window.location;
  if (new URLSearchParams(search).has('console')) return false;
  if (pathname === '/m' || pathname.startsWith('/m/')) return true;
  const touch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  return touch && Math.min(window.screen.width, window.screen.height) < 600;
}

const noop = () => undefined;

/**
 * The phone is a demo device, not an operator console: just the stage. Unlike
 * the desktop it waits for a tap, because iOS gives a page no audio and no
 * microphone until someone touches it. That same tap asks for fullscreen,
 * which Android grants. iPhone Safari never does for a page, so it goes
 * edge to edge only when opened from the home screen (see the manifest).
 */
export function PhoneStage({ agentName, problem }: { agentName: string; problem: string | null }) {
  const {
    turns,
    phase,
    problem: sessionProblem,
    activity,
    isMuted,
    start,
    stop,
    getOutputVolume,
    getInputVolume,
    getOutputByteFrequencyData,
  } = useSreConversation();

  // A console that cannot load its tools has nothing to talk with; say so in
  // the subtitles rather than letting a tap fail silently.
  const shownProblem: SessionProblem | null = sessionProblem ?? (problem ? { message: problem, needs: null } : null);

  const inSession = phase === 'live' || phase === 'reconnecting' || phase === 'ending';
  useWakeLock(inSession);

  const toggle = () => {
    if (inSession) {
      void stop();
      return;
    }
    enterBrowserFullscreen();
    void start();
  };

  return (
    <Stage
      phone
      activity={activity}
      muted={isMuted}
      turns={turns}
      problem={shownProblem}
      inSession={inSession}
      agentName={agentName}
      onToggleSession={toggle}
      // Nothing to go back to: leaving fullscreen just leaves the page as it is.
      onExit={noop}
      getOutputVolume={getOutputVolume}
      getInputVolume={getInputVolume}
      getOutputFrequency={getOutputByteFrequencyData}
    />
  );
}

type WakeLockSentinel = { release: () => Promise<void> };
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> } };

/**
 * Keeps the screen on while she is talking. A phone dimming mid-answer is
 * the quickest way to lose a room. The browser drops the lock whenever the
 * page is hidden, so it is taken again on return.
 */
function useWakeLock(active: boolean) {
  useEffect(() => {
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (!active || !wakeLock) return undefined;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const take = () => {
      if (document.visibilityState !== 'visible') return;
      wakeLock
        .request('screen')
        .then((s) => {
          if (cancelled) void s.release().catch(noop);
          else sentinel = s;
        })
        .catch(noop);
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', take);
      void sentinel?.release().catch(noop);
    };
  }, [active]);
}
