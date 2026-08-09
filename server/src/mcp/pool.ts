import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '../logger.js';
import type { McpServerConfig } from '../store/schema.js';
import { qualify, unqualify } from './names.js';

const CLIENT_INFO = { name: 'srevoice', version: '1.0.0' };
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 45_000;

export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'error';

export interface CatalogueEntry {
  qualifiedName: string;
  serverId: string;
  serverLabel: string;
  /** The name the MCP server actually knows, before namespacing/truncation. */
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ServerStatus {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  state: ConnectionState;
  toolCount: number;
  error: string | null;
  connectedAt: string | null;
}

interface Connection {
  config: McpServerConfig;
  client: Client | null;
  state: ConnectionState;
  error: string | null;
  connectedAt: string | null;
  tools: Map<string, CatalogueEntry>;
}

/** Config identity — a change to any of these requires a reconnect. */
function fingerprint(c: McpServerConfig): string {
  return JSON.stringify([c.url, c.headers, c.enabled]);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Holds one live MCP client per configured server and presents their tools as a
 * single flat, namespaced catalogue.
 *
 * Transport negotiation: Streamable HTTP is tried first, and a failure that
 * looks like an old-style endpoint falls back to SSE. Hosted MCP providers are
 * mid-migration between the two, so pinning either one strands half of them.
 */
export class McpPool {
  private connections = new Map<string, Connection>();
  private fingerprints = new Map<string, string>();

  /** Reconciles live connections against the desired config set. */
  async sync(configs: McpServerConfig[]): Promise<void> {
    const desired = new Map(configs.map((c) => [c.id, c]));

    for (const id of [...this.connections.keys()]) {
      if (!desired.has(id)) await this.disconnect(id);
    }

    await Promise.all(
      configs.map(async (config) => {
        const previous = this.fingerprints.get(config.id);
        const current = fingerprint(config);
        const existing = this.connections.get(config.id);

        // Reuse a healthy connection whose transport-relevant config is unchanged.
        if (existing && previous === current && existing.state === 'ready') {
          existing.config = config;
          return;
        }
        if (previous !== current) await this.disconnect(config.id);

        this.fingerprints.set(config.id, current);
        if (!config.enabled) {
          this.connections.set(config.id, {
            config,
            client: null,
            state: 'idle',
            error: null,
            connectedAt: null,
            tools: new Map(),
          });
          return;
        }
        await this.connect(config);
      }),
    );
  }

  private async openTransport(config: McpServerConfig): Promise<{ client: Client; via: string }> {
    const url = new URL(config.url);
    const requestInit: RequestInit = { headers: { ...config.headers } };

    const attempt = async (transport: Transport, via: string) => {
      const client = new Client(CLIENT_INFO);
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP connect (${via})`);
      return { client, via };
    };

    try {
      return await attempt(new StreamableHTTPClientTransport(url, { requestInit }), 'streamable-http');
    } catch (streamErr) {
      logger.debug(
        { serverId: config.id, err: describeError(streamErr) },
        'Streamable HTTP failed, trying SSE',
      );
      try {
        return await attempt(new SSEClientTransport(url, { requestInit }), 'sse');
      } catch (sseErr) {
        // Report the Streamable HTTP failure: it is the modern transport and
        // almost always the real error, with SSE just confirming it.
        throw new Error(
          `${describeError(streamErr)} (SSE fallback also failed: ${describeError(sseErr)})`,
        );
      }
    }
  }

  private async connect(config: McpServerConfig): Promise<void> {
    this.connections.set(config.id, {
      config,
      client: null,
      state: 'connecting',
      error: null,
      connectedAt: null,
      tools: new Map(),
    });

    try {
      const { client, via } = await this.openTransport(config);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'MCP listTools');

      const tools = new Map<string, CatalogueEntry>();
      for (const tool of listed.tools) {
        const qualifiedName = qualify(config.id, tool.name);
        if (tools.has(qualifiedName)) {
          logger.warn(
            { serverId: config.id, tool: tool.name, qualifiedName },
            'Tool name collided after namespacing — skipping duplicate',
          );
          continue;
        }
        tools.set(qualifiedName, {
          qualifiedName,
          serverId: config.id,
          serverLabel: config.label,
          remoteName: tool.name,
          description: tool.description ?? `${config.label} tool ${tool.name}`,
          inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        });
      }

      this.connections.set(config.id, {
        config,
        client,
        state: 'ready',
        error: null,
        connectedAt: new Date().toISOString(),
        tools,
      });
      logger.info({ serverId: config.id, via, toolCount: tools.size }, 'MCP server connected');
    } catch (err) {
      const message = describeError(err);
      this.connections.set(config.id, {
        config,
        client: null,
        state: 'error',
        error: message,
        connectedAt: null,
        tools: new Map(),
      });
      logger.error({ serverId: config.id, err: message }, 'MCP server connection failed');
    }
  }

  private async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn?.client) {
      await conn.client.close().catch((err) => {
        logger.debug({ serverId: id, err: describeError(err) }, 'Error closing MCP client');
      });
    }
    this.connections.delete(id);
    this.fingerprints.delete(id);
  }

  /** Forces a fresh connection — used by the "retry" affordance in the UI. */
  async reconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`Unknown MCP server: ${id}`);
    const config = conn.config;
    await this.disconnect(id);
    this.fingerprints.set(id, fingerprint(config));
    if (config.enabled) await this.connect(config);
  }

  catalogue(): CatalogueEntry[] {
    return [...this.connections.values()]
      .flatMap((c) => [...c.tools.values()])
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  }

  status(): ServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      id: c.config.id,
      label: c.config.label,
      url: c.config.url,
      enabled: c.config.enabled,
      state: c.state,
      toolCount: c.tools.size,
      error: c.error,
      connectedAt: c.connectedAt,
    }));
  }

  /**
   * Executes a namespaced tool. A dead connection is retried once before
   * failing: hosted MCP sessions expire, and a silent reconnect is far better
   * than telling the caller mid-conversation that the tool vanished.
   */
  async call(qualifiedName: string, args: Record<string, unknown>): Promise<unknown> {
    const parsed = unqualify(qualifiedName);
    if (!parsed) throw new Error(`Malformed tool name: ${qualifiedName}`);

    const conn = this.connections.get(parsed.serverId);
    if (!conn) throw new Error(`No MCP server configured with id "${parsed.serverId}"`);

    const entry = conn.tools.get(qualifiedName);
    if (!entry) {
      throw new Error(`Tool "${qualifiedName}" is not in the catalogue for ${conn.config.label}`);
    }

    const invoke = async () => {
      const client = this.connections.get(parsed.serverId)?.client;
      if (!client) throw new Error(`MCP server "${conn.config.label}" is not connected`);
      return withTimeout(
        client.callTool({ name: entry.remoteName, arguments: args }),
        CALL_TIMEOUT_MS,
        `MCP call ${qualifiedName}`,
      );
    };

    try {
      return await invoke();
    } catch (err) {
      logger.warn(
        { tool: qualifiedName, err: describeError(err) },
        'MCP call failed — reconnecting and retrying once',
      );
      await this.reconnect(parsed.serverId);
      return invoke();
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}
