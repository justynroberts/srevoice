import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import type { ToolCall } from '../hooks/useSreConversation';
import { formatDuration, humaniseToolName } from '../lib/format';
import { DataView } from './DataView';

function StatusDot({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') {
    return (
      <span className="relative flex h-2 w-2" aria-label="Running">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
      </span>
    );
  }
  return (
    <span
      className={`h-2 w-2 rounded-full ${status === 'ok' ? 'bg-ok' : 'bg-critical'}`}
      aria-label={status === 'ok' ? 'Succeeded' : 'Failed'}
    />
  );
}

function ArgsSummary({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.slice(0, 4).map(([key, value]) => (
        <span
          key={key}
          className="rounded border border-line/70 bg-void/50 px-1.5 py-0.5 font-mono-tight text-[10px] text-ink-faint"
        >
          {key}=
          <span className="text-ink-dim">
            {typeof value === 'object' ? JSON.stringify(value).slice(0, 30) : String(value).slice(0, 30)}
          </span>
        </span>
      ))}
      {entries.length > 4 && (
        <span className="px-1 py-0.5 text-[10px] text-ink-faint">+{entries.length - 4} more</span>
      )}
    </div>
  );
}

export function ToolCallCard({ call, defaultOpen }: { call: ToolCall; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { server, action } = humaniseToolName(call.tool);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="surface-card overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 p-3 text-left transition-colors hover:bg-raised/60"
      >
        <span className="mt-1.5">
          <StatusDot status={call.status} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium capitalize text-ink">{action}</span>
            {server && (
              <span className="font-mono-tight text-[10px] uppercase tracking-wider text-ink-faint">
                {server}
              </span>
            )}
            {call.durationMs !== undefined && (
              <span className="ml-auto shrink-0 font-mono-tight text-[10px] text-ink-faint">
                {formatDuration(call.durationMs)}
              </span>
            )}
          </span>
          <ArgsSummary args={call.args} />
        </span>

        <svg
          className={`mt-1 h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="border-t border-line px-3 py-3">
              {call.status === 'running' && (
                <p className="text-[12px] text-ink-faint">Waiting for the MCP server…</p>
              )}
              {call.status === 'error' && (
                <p className="rounded-lg border border-critical/30 bg-critical/10 p-2.5 text-[12px] text-critical">
                  {call.error ?? 'The tool call failed.'}
                </p>
              )}
              {call.status === 'ok' && call.result && (
                <>
                  <DataView value={call.result.display} />
                  {call.result.truncated && (
                    <p className="mt-2 text-[11px] text-warn">
                      Trimmed before it reached the agent — the full payload is above.
                    </p>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}
