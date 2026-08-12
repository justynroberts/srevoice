import type { MemoryStore } from '../store/memory.js';
import type { RenderedResult } from '../mcp/render.js';

/**
 * Memory presented as ordinary client tools, so it flows through the same
 * provisioning, routing and display path as every MCP tool rather than needing
 * a parallel mechanism.
 *
 * The `memory__` prefix matches the `<server>__<tool>` convention used for MCP
 * tools, which keeps `unqualify` and the UI's server grouping working unchanged.
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
] as const;

const NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));

export function isMemoryTool(name: string): boolean {
  return NAMES.has(name as (typeof MEMORY_TOOLS)[number]['name']);
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

  return { speech: `Unknown memory tool ${tool}.`, display: null, isError: true, truncated: false };
}
