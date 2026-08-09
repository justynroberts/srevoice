/**
 * Splits an MCP tool result into the two things this app needs:
 *
 *  - `speech`: compact text handed back to the voice agent. Kept short on
 *    purpose — a 40kB incident dump read aloud is useless, and it burns the
 *    agent's context for no benefit.
 *  - `display`: the full structured payload, pushed to the screen where length
 *    costs nothing.
 */

const SPEECH_BUDGET = 6000;

export interface RenderedResult {
  speech: string;
  display: unknown;
  isError: boolean;
  truncated: boolean;
}

interface McpContentBlock {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

function coerceJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function renderToolResult(raw: unknown): RenderedResult {
  const result = (raw ?? {}) as { content?: McpContentBlock[]; structuredContent?: unknown; isError?: boolean };
  const isError = result.isError === true;

  const blocks = Array.isArray(result.content) ? result.content : [];
  const textParts = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string);
  const joined = textParts.join('\n\n').trim();

  // Preference order for the screen: explicit structured content, then JSON we
  // can recover from the text block, then the raw text, then the whole result.
  let display: unknown;
  if (result.structuredContent !== undefined) {
    display = result.structuredContent;
  } else if (joined) {
    display = coerceJson(joined) ?? joined;
  } else if (blocks.length > 0) {
    // Non-text blocks (images, resources) have no speech form, but the screen
    // can still show them.
    display = blocks;
  } else {
    // A genuinely empty result. Echoing the envelope back would have the agent
    // read `{"content":[]}` out loud.
    display = null;
  }

  let speech = joined;
  if (!speech) {
    speech = display === null || display === undefined ? '' : JSON.stringify(display);
  }

  const truncated = speech.length > SPEECH_BUDGET;
  if (truncated) {
    speech = `${speech.slice(0, SPEECH_BUDGET)}\n\n[Result truncated for speech. The full payload is on screen — summarise what is shown and offer to narrow the query.]`;
  }

  if (!speech) speech = isError ? 'The tool returned an error with no detail.' : 'The tool returned no content.';

  return { speech, display, isError, truncated };
}
