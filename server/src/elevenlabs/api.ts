import { logger } from '../logger.js';

const BASE_URL = 'https://api.elevenlabs.io';
const REQUEST_TIMEOUT_MS = 30_000;

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ElevenLabsError';
  }

  /** True when the caller's key is wrong or lacks Agents access. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ClientToolConfig {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ElevenLabsClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('ElevenLabs API key is required');
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'xi-api-key': this.apiKey,
          'content-type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ElevenLabsError(`ElevenLabs request to ${path} timed out`, 504, null);
      }
      throw new ElevenLabsError(`ElevenLabs request to ${path} failed: ${(err as Error).message}`, 502, null);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const body = text ? safeJson(text) : null;

    if (!response.ok) {
      throw new ElevenLabsError(
        `ElevenLabs ${init.method ?? 'GET'} ${path} failed with ${response.status}: ${describe(body) ?? text.slice(0, 300)}`,
        response.status,
        body,
      );
    }
    return body as T;
  }

  /** Cheap credential probe used by the settings page. */
  async verifyKey(): Promise<{ ok: true; subscriptionTier?: string }> {
    const user = await this.request<{ subscription?: { tier?: string } }>('/v1/user');
    return { ok: true, subscriptionTier: user?.subscription?.tier };
  }

  async listVoices(): Promise<Array<{ voice_id: string; name: string; category?: string }>> {
    const res = await this.request<{ voices?: Array<{ voice_id: string; name: string; category?: string }> }>(
      '/v1/voices',
    );
    return res?.voices ?? [];
  }

  async createClientTool(config: ClientToolConfig): Promise<string> {
    const res = await this.request<{ id?: string; tool_id?: string }>('/v1/convai/tools', {
      method: 'POST',
      body: JSON.stringify({ tool_config: toolConfigBody(config) }),
    });
    const id = res?.id ?? res?.tool_id;
    if (!id) throw new ElevenLabsError('ElevenLabs did not return a tool id', 502, res);
    return id;
  }

  async updateClientTool(toolId: string, config: ClientToolConfig): Promise<void> {
    await this.request(`/v1/convai/tools/${encodeURIComponent(toolId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ tool_config: toolConfigBody(config) }),
    });
  }

  async deleteTool(toolId: string): Promise<void> {
    try {
      await this.request(`/v1/convai/tools/${encodeURIComponent(toolId)}`, { method: 'DELETE' });
    } catch (err) {
      // A tool deleted in the ElevenLabs dashboard is already in the desired
      // state; only surface anything else.
      if (err instanceof ElevenLabsError && err.status === 404) return;
      throw err;
    }
  }

  async createAgent(body: Record<string, unknown>): Promise<string> {
    const res = await this.request<{ agent_id?: string }>('/v1/convai/agents/create', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res?.agent_id) throw new ElevenLabsError('ElevenLabs did not return an agent id', 502, res);
    return res.agent_id;
  }

  async updateAgent(agentId: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/v1/convai/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  async agentExists(agentId: string): Promise<boolean> {
    try {
      await this.request(`/v1/convai/agents/${encodeURIComponent(agentId)}`);
      return true;
    } catch (err) {
      if (err instanceof ElevenLabsError && err.status === 404) return false;
      throw err;
    }
  }

  async getSignedUrl(agentId: string): Promise<string> {
    const res = await this.request<{ signed_url?: string }>(
      `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    );
    if (!res?.signed_url) throw new ElevenLabsError('ElevenLabs did not return a signed URL', 502, res);
    return res.signed_url;
  }
}

function toolConfigBody(config: ClientToolConfig) {
  return {
    type: 'client',
    name: config.name,
    description: config.description,
    // The agent must wait for the browser to round-trip through our MCP proxy,
    // otherwise it narrates an answer before the data exists.
    expects_response: true,
    response_timeout_secs: 60,
    parameters: config.parameters,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const detail = b.detail ?? b.message ?? b.error;
  if (typeof detail === 'string') return detail;
  if (detail) {
    const s = JSON.stringify(detail);
    logger.debug({ detail }, 'ElevenLabs error detail');
    return s.slice(0, 300);
  }
  return undefined;
}
