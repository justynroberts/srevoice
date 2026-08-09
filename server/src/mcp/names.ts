/**
 * ElevenLabs tool names are constrained to a short identifier charset, while
 * MCP servers are free to use dots, slashes and long names. Every qualified
 * name is `<serverId>__<sanitisedTool>` so routing back to the owning server is
 * a pure string split — no lookup table to fall out of sync.
 */
const SEPARATOR = '__';
const MAX_LENGTH = 64;

export function sanitiseToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '');
}

export function qualify(serverId: string, toolName: string): string {
  const base = `${serverId}${SEPARATOR}${sanitiseToolName(toolName)}`;
  if (base.length <= MAX_LENGTH) return base;

  // Truncate the tool half, never the server half — the prefix is what makes
  // the name routable.
  const room = MAX_LENGTH - serverId.length - SEPARATOR.length;
  if (room < 4) {
    throw new Error(`MCP server id "${serverId}" is too long to namespace tools`);
  }
  return `${serverId}${SEPARATOR}${sanitiseToolName(toolName).slice(0, room)}`;
}

export function unqualify(qualified: string): { serverId: string; toolName: string } | null {
  const idx = qualified.indexOf(SEPARATOR);
  if (idx <= 0) return null;
  return {
    serverId: qualified.slice(0, idx),
    toolName: qualified.slice(idx + SEPARATOR.length),
  };
}
