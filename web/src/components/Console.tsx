import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSreConversation } from '../hooks/useSreConversation';
import { useTheme } from '../hooks/useTheme';
import type { ServerStatus } from '../lib/api';
import { ToolCallCard } from './ToolCallCard';
import { Transcript } from './Transcript';
import { Avatar } from './Avatar';
import { Button, Callout, Icon } from './ui';

interface Props {
  tools: string[];
  statuses: ServerStatus[];
  agentName: string;
  onOpenSettings: () => void;
}

const PANEL_KEY = 'srevoice.dataPanelOpen';

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" aria-hidden>
      <rect x="7.25" y="2.25" width="5.5" height="9.5" rx="2.75" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {off && <path d="M3.5 3.5l13 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * Mic on/off, sized and animated to be found without looking. In a noisy room
 * the whole conversation moves to the keyboard, so this is a first-class
 * control rather than a word tucked next to the others.
 *
 * Labelled by what pressing it does, not by the state it is in — "Mute" while
 * listening, "Listen" while muted — because that is the question being asked
 * of the button.
 */
function MicToggle({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={muted}
      aria-label={muted ? 'Microphone is off. Turn it back on.' : 'Microphone is on. Mute it and type instead.'}
      title={muted ? 'Mic is off — type below' : 'Mute the mic and type instead'}
      className={`press relative inline-flex min-h-[2.75rem] items-center gap-2 rounded-xl border px-4 py-2.5 text-[14px] font-medium ${
        muted
          ? 'mic-off border-warn/40 bg-warn/10 text-warn'
          : 'mic-live border-accent/40 bg-accent/10 text-accent'
      }`}
    >
      <MicIcon off={muted} />
      <span>{muted ? 'Listen' : 'Mute'}</span>
    </button>
  );
}

function ConnectionSummary({ statuses, toolCount }: { statuses: ServerStatus[]; toolCount: number }) {
  const enabled = statuses.filter((s) => s.enabled);
  const ready = statuses.filter((s) => s.state === 'ready');
  const failed = enabled.filter((s) => s.state === 'error');

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={ready.length ? 'text-ok' : 'text-ink-faint'}>
        {ready.length}/{enabled.length} connected
      </span>
      <span className="text-ink-faint">·</span>
      <span className="text-ink-dim">{toolCount} tools</span>
      {failed.length > 0 && (
        <>
          <span className="text-ink-faint">·</span>
          <span className="text-critical">{failed.length} down</span>
        </>
      )}
    </div>
  );
}

export function Console({ tools, statuses, agentName, onOpenSettings }: Props) {
  const {
    turns,
    toolCalls,
    phase,
    problem,
    activity,
    isMuted,
    setMuted,
    start,
    stop,
    clear,
    sendText,
    dismissProblem,
  } = useSreConversation();

  const { choice, resolved, cycle } = useTheme();
  const [draft, setDraft] = useState('');
  // Collapsed by default on narrow screens; the choice sticks per browser.
  const [panelOpen, setPanelOpen] = useState(() => {
    const stored = localStorage.getItem(PANEL_KEY);
    if (stored !== null) return stored === 'true';
    return typeof window === 'undefined' ? true : window.innerWidth >= 1024;
  });

  useEffect(() => {
    localStorage.setItem(PANEL_KEY, String(panelOpen));
  }, [panelOpen]);

  const live = phase === 'live';
  const running = toolCalls.filter((c) => c.status === 'running').length;

  // Newest first. Built explicitly rather than with `flex-col-reverse`, which
  // reverses the paint order but leaves the scroll container anchored to the
  // flex start — i.e. parked on the oldest call, with every new result landing
  // off-screen above it.
  const newest = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : undefined;
  const ordered = [...toolCalls].reverse();

  const inputRef = useRef<HTMLInputElement>(null);
  // Turning the mic off is only half the intent — the other half is "I am going
  // to type now", so put the caret where it is needed.
  const toggleMic = () => {
    const next = !isMuted;
    setMuted(next);
    if (next) requestAnimationFrame(() => inputRef.current?.focus());
  };

  const resultsRef = useRef<HTMLDivElement>(null);
  // A new call arrives at the top, so the top is where the eye needs to be.
  // Results that fill in later grow downwards from there and stay in view.
  useEffect(() => {
    if (newest) resultsRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [newest?.id]);

  // Something new arrived while the panel was shut — worth a nudge.
  const unseen = !panelOpen && toolCalls.length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    sendText(draft);
    setDraft('');
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-3">
        <div className="flex items-center gap-4">
          <Avatar activity={activity} muted={isMuted} name={agentName} />
          <div className="hidden h-10 w-px bg-line sm:block" />
          <div className="hidden sm:block">
            <ConnectionSummary statuses={statuses} toolCount={tools.length} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {live && <MicToggle muted={isMuted} onToggle={toggleMic} />}
          {turns.length > 0 && (
            <Button tone="ghost" onClick={clear} className="hidden sm:inline-flex">
              <Icon.clear />
              Clear
            </Button>
          )}
          <Button
            tone={live ? 'danger' : 'primary'}
            onClick={live ? stop : start}
            loading={phase === 'connecting' || phase === 'requesting-mic' || phase === 'ending'}
          >
            {live ? <Icon.stop /> : <Icon.play />}
            {live ? 'End session' : 'Start session'}
          </Button>
          <Button
            tone="ghost"
            onClick={cycle}
            size="icon"
            aria-label={`Theme: ${choice}. Click to change.`}
            title={choice === 'system' ? `Following your system (${resolved})` : `${choice} mode`}
          >
            {choice === 'system' ? (
              <svg viewBox="0 0 16 16" className="h-[1.15rem] w-[1.15rem]" fill="none" aria-hidden>
                <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M5.5 13.75h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            ) : resolved === 'dark' ? (
              <svg viewBox="0 0 16 16" className="h-[1.15rem] w-[1.15rem]" fill="none" aria-hidden>
                <path
                  d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" className="h-[1.15rem] w-[1.15rem]" fill="none" aria-hidden>
                <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </Button>

          <Button tone="ghost" onClick={onOpenSettings} size="icon" aria-label="Open settings">
            <svg viewBox="0 0 16 16" className="h-[1.15rem] w-[1.15rem]" fill="none" aria-hidden>
              <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </Button>
        </div>
      </header>

      <AnimatePresence>
        {problem && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="shrink-0 overflow-hidden px-5 pt-3"
          >
            <Callout tone="error">
              <div className="flex items-start justify-between gap-3">
                <span>{problem.message}</span>
                <div className="flex shrink-0 gap-2">
                  {problem.needs && (
                    <button type="button" onClick={onOpenSettings} className="underline underline-offset-2">
                      {problem.needs === 'provision' ? 'Provision' : 'Open settings'}
                    </button>
                  )}
                  <button type="button" onClick={dismissProblem} aria-label="Dismiss">
                    ✕
                  </button>
                </div>
              </div>
            </Callout>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`grid min-h-0 flex-1 transition-[grid-template-columns] duration-300 ease-out ${
          panelOpen ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]' : 'lg:grid-cols-[minmax(0,1fr)_3rem]'
        }`}
      >
        <section className="flex min-h-0 flex-col border-line lg:border-r">
          <div className="min-h-0 flex-1">
            <Transcript turns={turns} agentName={agentName} />
          </div>

          <form onSubmit={submit} className="shrink-0 border-t border-line p-3">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={!live}
                placeholder={
                  !live
                    ? 'Start a session to talk'
                    : isMuted
                      ? `Mic is off — type to ${agentName}`
                      : `Type to ${agentName} instead of speaking…`
                }
                className={`press min-h-[2.75rem] flex-1 rounded-xl border bg-void px-4 py-2.5 text-[14px] text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50 ${
                  isMuted && live ? 'border-warn/50' : 'border-line focus:border-accent'
                }`}
              />
              <Button tone={isMuted && live ? 'primary' : 'ghost'} type="submit" disabled={!live || !draft.trim()}>
                <Icon.send />
                Send
              </Button>
            </div>
          </form>
        </section>

        {/* Collapsed to a rail rather than removed — the toggle stays reachable
            and the running-call count is still visible while it is shut. */}
        <section className="flex min-h-0 flex-col overflow-hidden">
          <button
            type="button"
            onClick={() => setPanelOpen((o) => !o)}
            aria-expanded={panelOpen}
            className={`flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5 text-left transition-colors hover:bg-raised/60 ${
              panelOpen ? 'justify-between' : 'justify-center'
            }`}
          >
            {panelOpen ? (
              <>
                <span className="flex items-baseline gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                    What she looked up
                  </span>
                  {running > 0 && (
                    <span className="text-[11px] text-accent">{running} running</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {toolCalls.length > 0 && (
                    <span className="text-[11px] text-ink-faint">{toolCalls.length}</span>
                  )}
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-ink-faint" fill="none" aria-hidden>
                    <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </>
            ) : (
              <span className="relative flex flex-col items-center gap-1">
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-ink-faint" fill="none" aria-hidden>
                  <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {(running > 0 || unseen) && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${running > 0 ? 'animate-pulse bg-accent' : 'bg-ink-faint'}`}
                    aria-label={running > 0 ? 'Tool calls running' : 'New results'}
                  />
                )}
              </span>
            )}
          </button>

          {panelOpen && (
            <div ref={resultsRef} className="min-h-0 flex-1 overflow-y-auto p-3">
              {toolCalls.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <p className="text-[13px] text-ink-dim">Nothing looked up yet.</p>
                  <p className="max-w-xs text-[12px] leading-relaxed text-ink-faint">
                    Everything {agentName} checks lands here in full, while she gives you the short
                    version out loud.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {ordered.map((call, i) => (
                    <ToolCallCard key={call.id} call={call} defaultOpen={i === 0} />
                  ))}
                </div>
              )}
            </div>
          )}

          {!panelOpen && (
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="min-h-0 flex-1 [writing-mode:vertical-rl] py-4 text-[11px] font-semibold uppercase tracking-wider text-ink-faint transition-colors hover:text-accent"
            >
              What she looked up
              {toolCalls.length > 0 && ` · ${toolCalls.length}`}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
