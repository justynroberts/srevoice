import type { MemoryStore } from '../store/memory.js';
import type { RenderedResult } from '../mcp/render.js';

/**
 * Built-in capabilities presented as ordinary client tools, so they flow
 * through the same provisioning, routing and display path as every MCP tool
 * rather than needing a parallel mechanism.
 *
 * The `<server>__<tool>` naming matches the MCP convention, which keeps
 * `unqualify` and the UI's server grouping working unchanged.
 */
export const MEMORY_TOOLS = [
  {
    name: 'memory__remember',
    description:
      'Save something worth knowing in future sessions: a naming convention, who owns a service, a recurring ' +
      'cause, a preference the engineer states. Use it when you learn something durable — not for the details ' +
      'of the incident you are currently working, which will be stale tomorrow.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The fact to remember, written so it makes sense with no other context.',
        },
        tag: {
          type: 'string',
          description: 'Optional one-word grouping, such as a service or team name.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory__recall',
    description:
      'Search what you were told in previous sessions. You are handed the most relevant notes automatically at ' +
      'the start of each session, so use this only when you need something older or more specific.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to search for, such as a service, team or failure mode.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'screen__show',
    description:
      'Put something on the engineer\'s screen. The screen only ever shows raw tool results, so whenever you ' +
      'narrow, filter, sort, rank, compare or summarise data in your head — "just the criticals", "the three ' +
      'oldest", "only the ones on checkout" — call this with the rows you are actually talking about, or the ' +
      'engineer is left reading the unfiltered list while you describe a different one. Call it as well as ' +
      'answering out loud, not instead of.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short heading describing what is being shown, e.g. "Triggered P1s on checkout".',
        },
        items: {
          type: 'array',
          description: 'The rows to display — the filtered or derived subset, not the original result.',
          items: {
            type: 'string',
            description: 'One row, as JSON if it is structured, or plain text if it is a simple line.',
          },
        },
        note: {
          type: 'string',
          description: 'Optional one-line explanation of how this was narrowed down.',
        },
      },
      required: ['title', 'items'],
    },
  },
] as const;

const NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));

export function isMemoryTool(name: string): boolean {
  return NAMES.has(name as (typeof MEMORY_TOOLS)[number]['name']);
}

/** Rows arrive as strings; anything that parses as JSON renders as structured data. */
function parseRows(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.map((row) => {
    if (typeof row !== 'string') return row;
    const trimmed = row.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  });
}

export async function runMemoryTool(
  memory: MemoryStore,
  tool: string,
  args: Record<string, unknown>,
): Promise<RenderedResult> {
  if (tool === 'memory__remember') {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) {
      return { speech: 'I need something to remember.', display: null, isError: true, truncated: false };
    }
    const tag = typeof args.tag === 'string' ? args.tag : undefined;
    const note = await memory.remember(text, tag);
    return {
      speech: 'Noted — I will remember that.',
      display: { saved: note.text, tag: note.tag ?? null },
      isError: false,
      truncated: false,
    };
  }

  if (tool === 'memory__recall') {
    const query = typeof args.query === 'string' ? args.query : '';
    const notes = await memory.recall(query);
    if (notes.length === 0) {
      return {
        speech: `Nothing recorded about ${query || 'that'}.`,
        display: { query, notes: [] },
        isError: false,
        truncated: false,
      };
    }
    return {
      speech: notes.map((n) => `- ${n.text}`).join('\n'),
      display: { query, notes: notes.map((n) => ({ text: n.text, tag: n.tag ?? null })) },
      isError: false,
      truncated: false,
    };
  }

  if (tool === 'screen__show') {
    const title = typeof args.title === 'string' ? args.title.trim() : 'Filtered view';
    const items = parseRows(args.items);
    const note = typeof args.note === 'string' ? args.note.trim() : '';

    return {
      // Short and non-committal: she has already said the real answer out loud,
      // and anything longer here gets read back to the engineer twice.
      speech: 'On screen.',
      display: { title, note: note || undefined, items },
      isError: false,
      truncated: false,
    };
  }

  return { speech: `Unknown built-in tool ${tool}.`, display: null, isError: true, truncated: false };
}
