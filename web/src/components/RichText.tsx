import { useState, type ReactNode } from 'react';

/**
 * MCP servers and the agent both emit prose with code embedded in it — fenced
 * blocks for logs, queries and payloads, backticks for identifiers. Rendered as
 * plain text that becomes an unreadable wall, so split it out and give code its
 * own treatment.
 */

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string; lang: string | null };

const FENCE = /```([\w+-]*)\n?([\s\S]*?)```/g;

export function parseSegments(input: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of input.matchAll(FENCE)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ kind: 'text', text: input.slice(cursor, start) });
    segments.push({
      kind: 'code',
      lang: match[1] ? match[1].toLowerCase() : null,
      text: match[2].replace(/\n+$/, ''),
    });
    cursor = start + match[0].length;
  }

  if (cursor < input.length) segments.push({ kind: 'text', text: input.slice(cursor) });
  // An unterminated fence leaves the opener in the text; better to show it than
  // to swallow the content after it.
  return segments.filter((s) => s.kind === 'code' || s.text.trim().length > 0);
}

/** Splits a text run on single-backtick spans. */
function withInlineCode(text: string): ReactNode[] {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.map((part, i) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code key={i} className="code-inline text-accent">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

function CodeBlock({ text, lang }: { text: string; lang: string | null }) {
  const [copied, setCopied] = useState(false);
  const lines = text.split('\n').length;
  const [expanded, setExpanded] = useState(lines <= 24);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard is unavailable outside a secure context — the code is still
      // selectable, so there is nothing useful to say here.
    }
  };

  return (
    <figure className="my-2 overflow-hidden rounded-[0.625rem] border border-line">
      <figcaption className="flex items-center justify-between border-b border-line bg-raised px-3 py-1.5">
        <span className="font-mono-tight text-[10px] uppercase tracking-wider text-ink-faint">
          {lang ?? 'code'}
          <span className="ml-2 normal-case tracking-normal opacity-70">
            {lines} line{lines === 1 ? '' : 's'}
          </span>
        </span>
        <button
          type="button"
          onClick={copy}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-ink-faint transition-colors hover:text-accent"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre
        className={`code-block !rounded-none !border-0 text-ink-dim ${
          expanded ? 'max-h-[28rem] overflow-y-auto' : 'max-h-44 overflow-hidden'
        }`}
      >
        <code>{text}</code>
      </pre>
      {lines > 24 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="w-full border-t border-line bg-raised py-1 text-[11px] font-medium text-accent transition-opacity hover:opacity-80"
        >
          {expanded ? 'Collapse' : `Show all ${lines} lines`}
        </button>
      )}
    </figure>
  );
}

export function RichText({ text, className = '' }: { text: string; className?: string }) {
  const segments = parseSegments(text);

  if (segments.length === 1 && segments[0].kind === 'text') {
    return <p className={`whitespace-pre-wrap ${className}`}>{withInlineCode(segments[0].text)}</p>;
  }

  return (
    <div className={className}>
      {segments.map((segment, i) =>
        segment.kind === 'code' ? (
          <CodeBlock key={i} text={segment.text} lang={segment.lang} />
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {withInlineCode(segment.text)}
          </p>
        ),
      )}
    </div>
  );
}
