import { logger } from '../logger.js';
import type { CatalogueEntry, McpPool } from '../mcp/pool.js';
import type { SettingsStore } from '../store/settings.js';
import type { Settings } from '../store/schema.js';
import { ElevenLabsClient, ElevenLabsError } from './api.js';
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from './prompt.js';
import { normaliseToolParameters } from './schema.js';
import { MEMORY_TOOLS } from '../memory/tools.js';

export interface ProvisionReport {
  agentId: string;
  created: string[];
  updated: string[];
  removed: string[];
  toolCount: number;
  warnings: string[];
}

/**
 * Reconciles the live MCP tool catalogue into ElevenLabs: one convai *client*
 * tool per MCP tool, then an agent that references them all.
 *
 * Client tools (rather than ElevenLabs' native MCP integration) are deliberate.
 * The browser handles each call by asking this server to run it, which means
 * MCP credentials never leave the server, the MCP endpoints never need to be
 * reachable from ElevenLabs' network, and every result passes through here on
 * its way to the screen.
 */
export async function provision(
  store: SettingsStore,
  pool: McpPool,
  opts: { pruneRemoved?: boolean } = {},
): Promise<ProvisionReport> {
  const settings = await store.load();
  if (!settings.elevenlabsApiKey) {
    throw new ProvisionError('Add an ElevenLabs API key in Settings before provisioning.');
  }

  // Memory is registered like any other tool so she can save and search
  // without a separate mechanism.
  const catalogue: CatalogueEntry[] = [
    ...pool.catalogue(),
    ...MEMORY_TOOLS.map((t) => ({
      qualifiedName: t.name,
      serverId: 'memory',
      serverLabel: 'Memory',
      remoteName: t.name,
      description: t.description,
      inputSchema: t.inputSchema as unknown as Record<string, unknown>,
    })),
  ];
  const warnings: string[] = [];

  const failed = pool.status().filter((s) => s.enabled && s.state === 'error');
  for (const s of failed) {
    warnings.push(`${s.label} is not connected (${s.error ?? 'unknown error'}) — its tools were skipped.`);
  }
  if (catalogue.length === 0) {
    warnings.push('No MCP tools were discovered. The agent will be able to talk, but not to look anything up.');
  }

  const client = new ElevenLabsClient(settings.elevenlabsApiKey);
  const existing = { ...settings.provisioned.toolIds };
  const created: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const nextToolIds: Record<string, string> = {};

  for (const entry of catalogue) {
    const config = {
      name: entry.qualifiedName,
      description: toolDescription(entry),
      parameters: normaliseToolParameters(entry.inputSchema),
    };

    const knownId = existing[entry.qualifiedName];
    if (knownId) {
      try {
        await client.updateClientTool(knownId, config);
        nextToolIds[entry.qualifiedName] = knownId;
        updated.push(entry.qualifiedName);
        continue;
      } catch (err) {
        // The tool was probably deleted in the dashboard. Fall through and
        // recreate rather than failing the whole sync.
        if (!(err instanceof ElevenLabsError && err.status === 404)) {
          logger.warn({ tool: entry.qualifiedName, err: (err as Error).message }, 'Tool update failed, recreating');
        }
      }
    }

    try {
      nextToolIds[entry.qualifiedName] = await client.createClientTool(config);
      created.push(entry.qualifiedName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Could not register tool ${entry.qualifiedName}: ${message}`);
      logger.error({ tool: entry.qualifiedName, err: message }, 'Tool registration failed');
    }
  }

  // Tools whose MCP server was removed or renamed. Deleting is opt-in: a
  // transient connection failure should not destroy the registration.
  const orphans = Object.entries(existing).filter(([name]) => !(name in nextToolIds));
  if (opts.pruneRemoved !== false) {
    for (const [name, id] of orphans) {
      try {
        await client.deleteTool(id);
        removed.push(name);
      } catch (err) {
        warnings.push(`Could not delete stale tool ${name}: ${(err as Error).message}`);
        nextToolIds[name] = id;
      }
    }
  } else {
    for (const [name, id] of orphans) nextToolIds[name] = id;
  }

  const agentBody = buildAgentBody(settings, catalogue, Object.values(nextToolIds));
  const agentId = await upsertAgent(client, settings, agentBody);

  await store.update((current) => ({
    ...current,
    provisioned: {
      agentId,
      toolIds: nextToolIds,
      lastSyncedAt: new Date().toISOString(),
      toolCount: catalogue.length,
    },
  }));

  logger.info(
    { agentId, created: created.length, updated: updated.length, removed: removed.length },
    'ElevenLabs agent provisioned',
  );

  return { agentId, created, updated, removed, toolCount: catalogue.length, warnings };
}

async function upsertAgent(
  client: ElevenLabsClient,
  settings: Settings,
  body: Record<string, unknown>,
): Promise<string> {
  const knownId = settings.provisioned.agentId;
  if (knownId && (await client.agentExists(knownId))) {
    await client.updateAgent(knownId, body);
    return knownId;
  }
  return client.createAgent(body);
}

function buildAgentBody(
  settings: Settings,
  catalogue: CatalogueEntry[],
  toolIds: string[],
): Record<string, unknown> {
  const base = settings.agent.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

  return {
    name: settings.agent.name,
    conversation_config: {
      agent: {
        first_message: settings.agent.firstMessage,
        language: settings.agent.language,
        prompt: {
          prompt: buildSystemPrompt(base, catalogue, settings.agent.customInstructions),
          llm: settings.agent.llm,
          temperature: settings.agent.temperature,
          max_tokens: -1,
          tool_ids: toolIds,
        },
      },
      tts: {
        // ElevenLabs rejects an English agent on anything but turbo/flash v2,
        // so a multilingual pick that looks valid in the dropdown fails at
        // provision time. Coerce rather than surfacing their error verbatim.
        model_id: ttsModelFor(settings.voice.modelId, settings.agent.language),
        voice_id: settings.voice.voiceId,
        stability: settings.voice.stability,
        similarity_boost: settings.voice.similarityBoost,
        speed: settings.voice.speed,
      },
      turn: {
        // Incident talk has natural pauses while the engineer reads the screen.
        // A short timeout makes the agent talk over them.
        turn_timeout: 10,
      },
      conversation: {
        max_duration_seconds: settings.agent.maxDurationSeconds,
        client_events: ['audio', 'interruption', 'user_transcript', 'agent_response', 'agent_tool_response'],
      },
    },
  };
}

/**
 * English agents accept only the English-only TTS models: `eleven_turbo_v2`
 * and `eleven_flash_v2`. The `_v2_5` variants are the *multilingual* editions
 * and are rejected with "English Agents must use turbo or flash v2" — so the
 * match has to be exact, not a `v2` prefix.
 */
export function ttsModelFor(modelId: string, language: string): string {
  if (!language.toLowerCase().startsWith('en')) return modelId;
  if (modelId === 'eleven_turbo_v2' || modelId === 'eleven_flash_v2') return modelId;
  // Preserve the turbo/flash choice where the operator made one.
  return modelId.includes('turbo') ? 'eleven_turbo_v2' : 'eleven_flash_v2';
}

function toolDescription(entry: CatalogueEntry): string {
  const body = entry.description.replace(/\s+/g, ' ').trim();
  return `[${entry.serverLabel}] ${body}`.slice(0, 1000);
}

export class ProvisionError extends Error {}
