import { Children, isValidElement, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * MCP servers and the agent both emit Markdown — headings, lists, tables,
 * fenced code, links. Rendered as plain text it becomes an unreadable wall of
 * asterisks and pipes, so it is parsed properly.
 *
 * `react-markdown` never renders raw HTML unless explicitly enabled, which
 * matters here: tool output is third-party data reaching the browser.
 */

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

/** Pulls the text and language out of the `<code>` inside a fenced block. */
function readFence(children: ReactNode): { text: string; lang: string | null } {
  const only = Children.toArray(children)[0];
  if (!isValidElement(only)) return { text: String(children ?? ''), lang: null };

  const props = only.props as { className?: string; children?: ReactNode };
  const match = /language-([\w+-]+)/.exec(props.className ?? '');
  return {
    text: String(props.children ?? '').replace(/\n$/, ''),
    lang: match ? match[1].toLowerCase() : null,
  };
}

/**
 * Speech, rendered literally. The transcript must not be parsed as Markdown —
 * an identifier like `checkout_api_v2` would come out italicised and mangled,
 * and Paige is told not to speak Markdown in the first place. Backticked spans
 * are still styled, since those read as identifiers either way.
 */
export function SpokenText({ text, className = '' }: { text: string; className?: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <p className={`whitespace-pre-wrap ${className}`}>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code key={i} className="code-inline text-accent">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </p>
  );
}

export function RichText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Fenced blocks are handled at the `pre` level so the inner `code`
          // override only ever sees inline spans.
          pre: ({ children }) => {
            const { text: code, lang } = readFence(children);
            return <CodeBlock text={code} lang={lang} />;
          },
          code: ({ children }) => <code className="code-inline text-accent">{children}</code>,

          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          h1: ({ children }) => <h3 className="text-[13px] font-semibold text-ink">{children}</h3>,
          h2: ({ children }) => <h3 className="text-[13px] font-semibold text-ink">{children}</h3>,
          h3: ({ children }) => <h4 className="text-[12px] font-semibold text-ink">{children}</h4>,
          h4: ({ children }) => <h4 className="text-[12px] font-semibold text-ink">{children}</h4>,

          ul: ({ children }) => <ul className="list-disc space-y-1 pl-4">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-4">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,

          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="opacity-60">{children}</del>,

          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent underline underline-offset-2 transition-opacity hover:opacity-80"
            >
              {children}
            </a>
          ),

          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line-strong pl-3 text-ink-faint">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-line" />,

          // Tables scroll inside their own container so a wide one never makes
          // the whole panel scroll sideways.
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-left text-[12px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-raised">{children}</thead>,
          tr: ({ children }) => <tr className="border-t border-line/60">{children}</tr>,
          th: ({ children }) => (
            <th className="whitespace-nowrap px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="px-2.5 py-1.5 align-top text-ink-dim">{children}</td>,

          img: ({ src, alt }) => (
            <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} className="max-w-full rounded-lg" />
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
