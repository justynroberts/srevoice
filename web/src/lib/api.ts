const TOKEN_KEY = 'srevoice.accessToken';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The server can tell us the operator has a step to complete, not a bug to fix. */
  get needs(): 'apiKey' | 'provision' | null {
    const n = (this.body as { needs?: string } | null)?.needs;
    return n === 'apiKey' || n === 'provision' ? n : null;
  }
}

export function getAccessToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setAccessToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-srevoice-token': token } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const payload = body as { error?: string; issues?: ValidationIssue[] } | null;
    const base = payload?.error ?? `Request failed with ${response.status}`;
    // A bare "Invalid settings" is useless — the server names the offending
    // field and why, so surface that rather than dropping it.
    const detail = describeIssues(payload?.issues);
    throw new ApiError(detail ? `${base} — ${detail}` : base, response.status, body);
  }
  return body as T;
}

interface ValidationIssue {
  path?: (string | number)[];
  message?: string;
}

function describeIssues(issues: ValidationIssue[] | undefined): string | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;

  const parts = issues.slice(0, 3).map((issue) => {
    // Zod paths look like ["mcpServers", 0, "url"]; the index is noise to a
    // reader looking at a list of server cards, so make it 1-based prose.
    const path = (issue.path ?? [])
      .map((segment) => (typeof segment === 'number' ? `#${segment + 1}` : segment))
      .join('.')
      .replace(/\.#/g, ' #');
    const message = issue.message ?? 'is invalid';
    return path ? `${path}: ${message}` : message;
  });

  const more = issues.length > parts.length ? ` (+${issues.length - parts.length} more)` : '';
  return parts.join('; ') + more;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
};

// ---- Wire types ------------------------------------------------------------

export interface McpServerView {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  headerNames: string[];
  headerPreviews: Record<string, string | null>;
}

export interface SettingsView {
  version: number;
  elevenlabs: { configured: boolean; preview: string | null };
  voice: {
    voiceId: string;
    modelId: string;
    stability: number;
    similarityBoost: number;
    speed: number;
  };
  agent: {
    name: string;
    llm: string;
    temperature: number;
    language: string;
    firstMessage: string;
    systemPrompt?: string;
    maxDurationSeconds: number;
  };
  mcpServers: McpServerView[];
  provisioned: {
    agentId?: string;
    toolIds: Record<string, string>;
    lastSyncedAt?: string;
    toolCount: number;
  };
  updatedAt?: string;
}

export interface ServerStatus {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  state: 'idle' | 'connecting' | 'ready' | 'error';
  toolCount: number;
  error: string | null;
  connectedAt: string | null;
}

export interface CatalogueTool {
  name: string;
  server: string;
  serverId: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResponse {
  callId?: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  speech: string;
  display: unknown;
  truncated: boolean;
  durationMs: number;
}

export interface ProvisionReport {
  agentId: string;
  created: string[];
  updated: string[];
  removed: string[];
  toolCount: number;
  warnings: string[];
  servers: ServerStatus[];
}

export interface LlmOption {
  id: string;
  deprecated: boolean;
  sunsetting: boolean;
  replacement: string | null;
  supportsParallelToolCalls: boolean;
  maxContext: number | null;
}

export interface SettingsOptions {
  voices: { id: string; name: string; category?: string }[];
  llms: LlmOption[];
  ttsModels: { id: string; name: string }[];
  source: 'live' | 'none';
}

export interface SessionStart {
  signedUrl: string;
  agentId: string;
  tools: string[];
}
