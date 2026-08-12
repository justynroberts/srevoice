import { useState } from 'react';
import type { McpServerView } from '../lib/api';
import type { ServerStatus } from '../lib/api';
import { Button, Callout, TextInput, Toggle } from './ui';

/**
 * Header values are `null` when unchanged — the browser only ever receives
 * masked previews, so echoing them back would overwrite real tokens with dots.
 */
export interface DraftServer {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  headers: { key: string; value: string | null; preview: string | null }[];
}

export function toDraft(server: McpServerView): DraftServer {
  return {
    id: server.id,
    label: server.label,
    url: server.url,
    enabled: server.enabled,
    headers: server.headerNames.map((name) => ({
      key: name,
      value: null,
      preview: server.headerPreviews[name] ?? null,
    })),
  };
}

export function blankDraft(index: number): DraftServer {
  return {
    id: `mcp${index + 1}`,
    label: '',
    url: '',
    enabled: true,
    headers: [{ key: 'Authorization', value: '', preview: null }],
  };
}

/**
 * Pasting `mcp.pagerduty.com/mcp` without a scheme is the single most common
 * way to fail validation, so assume https rather than bouncing it back.
 */
function normaliseUrl(raw: string): string {
  const url = raw.trim();
  if (!url || /^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

export function draftToPayload(d: DraftServer) {
  const headers: Record<string, string | null> = {};
  for (const h of d.headers) {
    const key = h.key.trim();
    if (!key) continue;
    // An untouched header sends null so the server keeps what it has.
    if (h.value === null) headers[key] = null;
    else if (h.value.trim()) headers[key] = h.value.trim();
  }
  return {
    id: d.id.trim(),
    label: d.label.trim() || d.id.trim(),
    url: normaliseUrl(d.url),
    enabled: d.enabled,
    headers,
  };
}

function StatusPill({ status }: { status: ServerStatus | undefined }) {
  if (!status) {
    return <span className="text-[11px] text-ink-faint">not connected yet</span>;
  }
  const map = {
    ready: { text: `${status.toolCount} tools`, cls: 'text-ok' },
    connecting: { text: 'connecting…', cls: 'text-warn' },
    error: { text: 'failed', cls: 'text-critical' },
    idle: { text: 'disabled', cls: 'text-ink-faint' },
  }[status.state];

  return <span className={`font-mono-tight text-[11px] ${map.cls}`}>{map.text}</span>;
}

interface Props {
  draft: DraftServer;
  status: ServerStatus | undefined;
  onChange: (next: DraftServer) => void;
  onRemove: () => void;
  onReconnect: () => void;
  reconnecting: boolean;
}

export function McpServerEditor({ draft, status, onChange, onRemove, onReconnect, reconnecting }: Props) {
  const [showHeaders, setShowHeaders] = useState(draft.headers.length > 0);
  const patch = (p: Partial<DraftServer>) => onChange({ ...draft, ...p });

  const setHeader = (index: number, key: string, value: string | null) => {
    const headers = draft.headers.map((h, i) => (i === index ? { ...h, key, value } : h));
    patch({ headers });
  };

  return (
    <div className="surface-card space-y-3 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{draft.label || draft.id || 'New server'}</p>
          <StatusPill status={status} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Toggle checked={draft.enabled} onChange={(enabled) => patch({ enabled })} label="" />
          <Button tone="danger" onClick={onRemove} className="px-2 py-1 text-[11px]">
            Remove
          </Button>
        </div>
      </div>

      {status?.state === 'error' && status.error && (
        <Callout tone="error">
          {status.error}
          <button
            type="button"
            onClick={onReconnect}
            disabled={reconnecting}
            className="ml-2 underline underline-offset-2 disabled:opacity-50"
          >
            {reconnecting ? 'retrying…' : 'retry'}
          </button>
        </Callout>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          label="Reference"
          mono
          value={draft.id}
          onChange={(e) => patch({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
          placeholder="pd"
          hint="Prefixes every tool name. Short is better."
        />
        <TextInput
          label="Display name"
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
          placeholder="PagerDuty Incidents"
        />
      </div>

      <TextInput
        label="MCP endpoint"
        mono
        value={draft.url}
        onChange={(e) => patch({ url: e.target.value })}
        placeholder="https://mcp.pagerduty.com/mcp"
        hint="Streamable HTTP is tried first, then SSE."
      />

      <div>
        <button
          type="button"
          onClick={() => setShowHeaders((s) => !s)}
          className="text-[12px] font-medium text-accent transition-opacity hover:opacity-80"
        >
          {showHeaders ? 'Hide' : 'Show'} auth headers ({draft.headers.length})
        </button>

        {showHeaders && (
          <div className="mt-2 space-y-2">
            {draft.headers.map((header, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="w-2/5">
                  <TextInput
                    label={i === 0 ? 'Header' : ''}
                    mono
                    value={header.key}
                    onChange={(e) => setHeader(i, e.target.value, header.value)}
                    placeholder="Authorization"
                  />
                </div>
                <div className="flex-1">
                  <TextInput
                    label={i === 0 ? 'Value' : ''}
                    mono
                    type="password"
                    autoComplete="off"
                    value={header.value ?? ''}
                    onChange={(e) => setHeader(i, header.key, e.target.value)}
                    placeholder={header.preview ? `${header.preview} — leave blank to keep` : 'Bearer …'}
                  />
                </div>
                <Button
                  tone="ghost"
                  onClick={() => patch({ headers: draft.headers.filter((_, j) => j !== i) })}
                  className="mb-[1px] px-2 py-2"
                  aria-label="Remove header"
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              tone="ghost"
              onClick={() => patch({ headers: [...draft.headers, { key: '', value: '', preview: null }] })}
              className="px-2.5 py-1.5 text-[12px]"
            >
              + Header
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
