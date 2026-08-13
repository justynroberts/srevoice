import { useState } from 'react';
import { cellText, classify, type IncidentLike } from '../lib/inspect';
import { relativeTime, TONE_CLASSES, toneFor, truncate } from '../lib/format';
import { RichText } from './RichText';

function Badge({ value }: { value: string | undefined }) {
  if (!value) return null;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${TONE_CLASSES[toneFor(value)]}`}
    >
      {value}
    </span>
  );
}

function IncidentRow({ incident }: { incident: IncidentLike }) {
  const tone = toneFor(incident.status);
  const accent =
    tone === 'critical' ? 'bg-critical' : tone === 'warn' ? 'bg-warn' : tone === 'ok' ? 'bg-ok' : 'bg-line-strong';

  return (
    <li className="relative flex gap-3 rounded-lg bg-raised/60 p-3 transition-colors hover:bg-hover">
      <span className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full ${accent}`} aria-hidden />
      <div className="min-w-0 flex-1 pl-2">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] font-medium leading-snug text-ink">{incident.title}</p>
          {incident.number !== undefined && (
            <span className="shrink-0 font-mono-tight text-[11px] text-ink-faint">#{incident.number}</span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge value={incident.status} />
          {incident.urgency && <Badge value={incident.urgency} />}
          {incident.priority && (
            <span className="rounded-md border border-line bg-hover px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-dim">
              {incident.priority}
            </span>
          )}
          {incident.service && (
            <span className="font-mono-tight text-[11px] text-ink-dim">{incident.service}</span>
          )}
          {incident.assignee && (
            <span className="text-[11px] text-ink-faint">· {incident.assignee}</span>
          )}
          {incident.createdAt && (
            <span className="text-[11px] text-ink-faint">· {relativeTime(incident.createdAt)}</span>
          )}
        </div>
      </div>
      {incident.url && (
        <a
          href={incident.url}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 self-center rounded-md border border-line px-2 py-1 text-[11px] text-ink-dim transition-colors hover:border-accent/40 hover:text-accent"
        >
          Open
        </a>
      )}
    </li>
  );
}

/** Long, or carrying Markdown structure — either way it reads better parsed. */
const LOOKS_LIKE_PROSE = /\n|^.{120,}$|^[-*] |^#{1,6} |\|.*\|/s;

function JsonBlock({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const [expanded, setExpanded] = useState(text.length < 1200);

  return (
    <div className="relative">
      <pre
        className={`overflow-x-auto rounded-lg bg-void/70 p-3 font-mono-tight text-[11px] leading-relaxed text-ink-dim ${
          expanded ? 'max-h-[32rem] overflow-y-auto' : 'max-h-40 overflow-hidden'
        }`}
      >
        {text}
      </pre>
      {text.length >= 1200 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1.5 text-[11px] font-medium text-accent transition-opacity hover:opacity-80"
        >
          {expanded ? 'Collapse' : `Show all ${text.length.toLocaleString()} characters`}
        </button>
      )}
    </div>
  );
}

/**
 * Renders whatever a tool returned using the most specific view its shape
 * supports, degrading to raw JSON rather than hiding anything.
 */
export function DataView({ value }: { value: unknown }) {
  const shape = classify(value);

  switch (shape.kind) {
    case 'empty':
      return <p className="py-2 text-[12px] italic text-ink-faint">No results.</p>;

    case 'titled':
      return (
        <div>
          <p className="text-[12px] font-semibold text-ink">{shape.title}</p>
          {shape.note && <p className="mb-2 text-[11px] text-ink-faint">{shape.note}</p>}
          <div className={shape.note ? '' : 'mt-2'}>
            <DataView value={shape.inner} />
          </div>
        </div>
      );

    case 'text':
      return <RichText text={shape.text} className="text-[12px] leading-relaxed text-ink-dim" />;

    case 'lines':
      // Joined so a multi-line Markdown document split across array entries
      // still parses as one document — lists and tables span entries.
      return (
        <RichText
          text={shape.lines.join('\n')}
          className="text-[12px] leading-relaxed text-ink-dim"
        />
      );

    case 'incidents':
      return (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            {shape.total} incident{shape.total === 1 ? '' : 's'}
          </p>
          <ul className="space-y-1.5">
            {shape.incidents.slice(0, 250).map((incident) => (
              <IncidentRow key={incident.id} incident={incident} />
            ))}
          </ul>
          {shape.total > 250 && (
            <p className="mt-2 text-[11px] text-ink-faint">
              Showing the first 250 of {shape.total}. Ask {'\u2018'}narrow that down{'\u2019'} to see a
              filtered view.
            </p>
          )}
        </div>
      );

    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="bg-raised">
                {shape.columns.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint"
                  >
                    {col.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shape.rows.slice(0, 250).map((row, i) => (
                <tr key={i} className="border-t border-line/60 transition-colors hover:bg-raised/50">
                  {shape.columns.map((col) => (
                    <td key={col} className="max-w-[18rem] truncate px-2.5 py-1.5 text-ink-dim">
                      {truncate(cellText(row[col]), 90)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'object':
      return (
        <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(6rem,auto)_1fr]">
          {shape.entries.map(([key, val]) => (
            <div key={key} className="contents">
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                {key.replace(/_/g, ' ')}
              </dt>
              <dd className="min-w-0 break-words text-[12px] text-ink-dim">
                {typeof val === 'object' && val !== null ? (
                  <JsonBlock value={val} />
                ) : typeof val === 'string' && LOOKS_LIKE_PROSE.test(val) ? (
                  // Long or Markdown-ish values are messages, not cell data.
                  <RichText text={val} />
                ) : (
                  <span className="font-mono-tight">{cellText(val)}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      );

    case 'json':
      return <JsonBlock value={shape.value} />;
  }
}
