import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ElevenLabsClient, ElevenLabsError } from '../elevenlabs/api.js';
import { DEFAULT_SYSTEM_PROMPT } from '../elevenlabs/prompt.js';
import { logger, maskSecret } from '../logger.js';
import {
  agentSettingsSchema,
  mcpServerSchema,
  redactSettings,
  voiceSettingsSchema,
  type McpServerConfig,
} from '../store/schema.js';

/**
 * Header values arrive as `string | null`. `null` means "leave whatever is
 * already stored alone" — the browser only ever sees masked previews, so it
 * cannot echo a real secret back, and without this sentinel every save would
 * overwrite live tokens with dots.
 */
const incomingMcpServer = mcpServerSchema
  .omit({ headers: true })
  .extend({ headers: z.record(z.string().nullable()).default({}) });

/**
 * A `null` header that resolved to nothing. The stored secret is keyed on the
 * server id, so changing the id makes the lookup miss — and silently dropping
 * the header there means the save returns 200 while the endpoint starts
 * answering 401, with no clue as to why.
 */
class UnresolvedSecretError extends Error {
  constructor(
    readonly serverId: string,
    readonly header: string,
    readonly idChanged: boolean,
  ) {
    super(
      idChanged
        ? `No stored value for the "${header}" header on "${serverId}". Secrets are stored against the server id, ` +
          `so renaming an id loses them — re-enter the value for "${header}", or change the id back.`
        : `The "${header}" header on "${serverId}" has no value. Enter one, or remove the header.`,
    );
  }
}

/**
 * A saved system prompt replaces the built-in one outright and never updates
 * again. That is the right behaviour for someone who genuinely wrote their own,
 * and a trap for someone who opened the box, saved, and moved on — they are
 * pinned to that day's default and silently miss every improvement after it.
 *
 * Comparing section headings is crude but honest: it names what the stored
 * copy is missing rather than just claiming it is stale.
 */
function headings(text: string): string[] {
  return (text.match(/^##+ .*/gm) ?? []).map((h) => h.replace(/^#+\s*/, '').trim());
}

export function promptStatus(stored?: string) {
  const custom = stored?.trim();
  if (!custom) return { overridden: false, missingSections: [] as string[], ownSections: [] as string[] };

  const mine = new Set(headings(custom));
  const theirs = headings(DEFAULT_SYSTEM_PROMPT);
  return {
    overridden: true,
    // Present in the current built-in prompt, absent from the saved copy.
    missingSections: theirs.filter((h) => !mine.has(h)),
    // Anything genuinely their own — if this is empty, the saved copy is just
    // an old default and resetting costs nothing.
    ownSections: [...mine].filter((h) => !theirs.includes(h)),
  };
}

const updateBody = z.object({
  elevenlabsApiKey: z.string().min(1).nullable().optional(),
  voice: voiceSettingsSchema.partial().optional(),
  agent: agentSettingsSchema.partial().optional(),
  mcpServers: z.array(incomingMcpServer).max(10).optional(),
});

export const settingsRoutes = (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/settings', async () => {
      const settings = await ctx.store.load();
      return {
        settings: redactSettings(settings, maskSecret),
        defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
        promptStatus: promptStatus(settings.agent.systemPrompt),
      };
    });

    app.put('/api/settings', async (req, reply) => {
      const parsed = updateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid settings', issues: parsed.error.issues });
      }
      const patch = parsed.data;

      if (patch.mcpServers) {
        const ids = patch.mcpServers.map((s) => s.id);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dupes.length) {
          return reply.code(400).send({ error: `Duplicate MCP server id: ${[...new Set(dupes)].join(', ')}` });
        }
      }

      let next;
      try {
        next = await ctx.store.update((current) => {
        if (patch.elevenlabsApiKey !== undefined) {
          current.elevenlabsApiKey = patch.elevenlabsApiKey ?? undefined;
        }
        if (patch.voice) current.voice = { ...current.voice, ...patch.voice };
        if (patch.agent) current.agent = { ...current.agent, ...patch.agent };

        if (patch.mcpServers) {
          const previous = new Map(current.mcpServers.map((s) => [s.id, s]));
          current.mcpServers = patch.mcpServers.map((incoming): McpServerConfig => {
            const before = previous.get(incoming.id);
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(incoming.headers)) {
              const resolved = value ?? before?.headers[key];
              if (!resolved) {
                // `null` means "keep the stored value", and there isn't one —
                // the id changed, so the lookup missed. Dropping the header
                // here is silent credential loss: the save returns 200 and the
                // server starts answering 401. Refuse instead.
                throw new UnresolvedSecretError(incoming.id, key, before === undefined);
              }
              headers[key] = resolved;
            }
            return { ...incoming, headers };
          });
        }
        return current;
        });
      } catch (err) {
        // A rejected mutation leaves the store untouched and the write chain
        // alive, so the operator can simply correct the field and save again.
        if (err instanceof UnresolvedSecretError) {
          return reply.code(400).send({ error: err.message, server: err.serverId, header: err.header });
        }
        throw err;
      }

      // Apply MCP changes immediately — a saved-but-inert endpoint is a
      // confusing state to leave the operator in.
      if (patch.mcpServers) {
        await ctx.pool.sync(next.mcpServers);
      }

      return {
        settings: redactSettings(next, maskSecret),
        mcpStatus: ctx.pool.status(),
      };
    });

    /** Confirms the pasted key works before the operator tries to provision. */
    app.post('/api/settings/verify-elevenlabs', async (req, reply) => {
      const body = z.object({ apiKey: z.string().min(1).optional() }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'Invalid body' });

      const settings = await ctx.store.load();
      const key = body.data.apiKey ?? settings.elevenlabsApiKey;
      if (!key) return reply.code(400).send({ error: 'No ElevenLabs API key supplied or stored' });

      try {
        const result = await new ElevenLabsClient(key).verifyKey();
        return { ok: true, subscriptionTier: result.subscriptionTier, scopeNote: result.scopeNote };
      } catch (err) {
        if (err instanceof ElevenLabsError) {
          // Pass the upstream detail through. "Rejected" alone sends people
          // hunting for a typo when the real cause is usually a missing
          // Agents/ConvAI permission on a scoped key, or the wrong region.
          return reply.code(err.isAuthFailure ? 401 : 502).send({
            ok: false,
            error: err.isAuthFailure
              ? `ElevenLabs rejected that key for Agents. Check it has Agents (ConvAI) permission enabled — a key scoped to TTS only will fail here. Upstream said: ${err.message}`
              : err.message,
          });
        }
        throw err;
      }
    });

    /**
     * Everything the settings pickers offer, read live from ElevenLabs rather
     * than hardcoded: voices, reasoning models, TTS models. The lineup shifts
     * and is filtered per workspace by region and compliance tier, so a local
     * list would offer options the account cannot actually use.
     *
     * Each list fails soft and independently — one unavailable endpoint must
     * not blank the whole settings page.
     */
    app.get('/api/settings/options', async () => {
      const settings = await ctx.store.load();
      if (!settings.elevenlabsApiKey) {
        return { voices: [], llms: [], ttsModels: [], source: 'none' as const };
      }

      const client = new ElevenLabsClient(settings.elevenlabsApiKey);
      const soft = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fn();
        } catch (err) {
          logger.warn({ err: (err as Error).message, label }, 'Could not load ElevenLabs options');
          return fallback;
        }
      };

      const [voices, llms, ttsModels] = await Promise.all([
        soft('voices', () => client.listVoices(), []),
        soft('llms', () => client.listLlms(), []),
        soft('tts-models', () => client.listTtsModels(), []),
      ]);

      return {
        voices,
        llms,
        ttsModels,
        source: 'live' as const,
      };
    });
  };
