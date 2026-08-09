import { AnimatePresence, motion } from 'framer-motion';
import { useState, type FormEvent } from 'react';
import { useSreConversation } from '../hooks/useSreConversation';
import type { ServerStatus } from '../lib/api';
import { ToolCallCard } from './ToolCallCard';
import { Transcript } from './Transcript';
import { VoiceOrb } from './VoiceOrb';
import { Button, Callout } from './ui';

interface Props {
  tools: string[];
  statuses: ServerStatus[];
  onOpenSettings: () => void;
}

function ConnectionSummary({ statuses, toolCount }: { statuses: ServerStatus[]; toolCount: number }) {
  const failed = statuses.filter((s) => s.enabled && s.state === 'error');
  const ready = statuses.filter((s) => s.state === 'ready');

  return (
    <div className="flex items-center gap-2 font-mono-tight text-[11px]">
      <span className={ready.length ? 'text-ok' : 'text-ink-faint'}>
        {ready.length}/{statuses.filter((s) => s.enabled).length || 0} MCP
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

export function Console({ tools, statuses, onOpenSettings }: Props) {
  const {
    turns,
    toolCalls,
    phase,
    problem,
    isSpeaking,
    isMuted,
    setMuted,
    start,
    stop,
    clear,
    sendText,
    dismissProblem,
  } = useSreConversation();

  const [draft, setDraft] = useState('');
  const live = phase === 'live';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    sendText(draft);
    setDraft('');
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-3">
        <div className="flex items-center gap-4">
          <VoiceOrb phase={phase} isSpeaking={isSpeaking} muted={isMuted} />
          <div className="hidden h-8 w-px bg-line sm:block" />
          <div className="hidden sm:block">
            <ConnectionSummary statuses={statuses} toolCount={tools.length} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {live && (
            <Button tone="ghost" onClick={() => setMuted(!isMuted)} className="px-2.5 py-1.5 text-[12px]">
              {isMuted ? 'Unmute' : 'Mute'}
            </Button>
          )}
          {turns.length > 0 && (
            <Button tone="ghost" onClick={clear} className="px-2.5 py-1.5 text-[12px]">
              Clear
            </Button>
          )}
          <Button
            tone={live ? 'danger' : 'primary'}
            onClick={live ? stop : start}
            loading={phase === 'connecting' || phase === 'requesting-mic' || phase === 'ending'}
          >
            {live ? 'End session' : 'Start session'}
          </Button>
          <Button tone="ghost" onClick={onOpenSettings} className="px-2.5 py-2" aria-label="Open settings">
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
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

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="flex min-h-0 flex-col border-line lg:border-r">
          <div className="min-h-0 flex-1">
            <Transcript turns={turns} />
          </div>

          <form onSubmit={submit} className="shrink-0 border-t border-line p-3">
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={!live}
                placeholder={live ? 'Type instead of speaking…' : 'Start a session to talk'}
                className="flex-1 rounded-lg border border-line bg-void px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint transition-colors focus:border-accent focus:outline-none disabled:opacity-50"
              />
              <Button tone="ghost" type="submit" disabled={!live || !draft.trim()}>
                Send
              </Button>
            </div>
          </form>
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-baseline justify-between border-b border-line px-4 py-2.5">
            <h2 className="font-mono-tight text-[11px] uppercase tracking-wider text-ink-faint">Live data</h2>
            {toolCalls.length > 0 && (
              <span className="font-mono-tight text-[11px] text-ink-faint">{toolCalls.length} calls</span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {toolCalls.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="text-[13px] text-ink-dim">No tool calls yet.</p>
                <p className="max-w-xs text-[12px] leading-relaxed text-ink-faint">
                  Everything the agent looks up lands here in full, while it gives you the short version out
                  loud.
                </p>
              </div>
            ) : (
              <div className="flex flex-col-reverse gap-2.5">
                {toolCalls.map((call, i) => (
                  <ToolCallCard key={call.id} call={call} defaultOpen={i === toolCalls.length - 1} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
