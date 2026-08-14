import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ElevenLabsClient } from '../elevenlabs/api.js';

/**
 * Why did the last call end?
 *
 * Neither answer is visible from here: `session__end` is handled entirely in
 * the browser and never reaches this server, and a socket error never gets
 * this far either. Both look identical in the request log — a session that
 * simply stops making requests. ElevenLabs holds the only authoritative record,
 * so this route asks them.
 */
export const diagnosticsRoutes = (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/diagnostics/quota', async (_req, reply) => {
      const settings = await ctx.store.load();
      if (!settings.elevenlabsApiKey) return reply.code(400).send({ error: 'No ElevenLabs API key configured' });

      const sub = await new ElevenLabsClient(settings.elevenlabsApiKey).subscription();
      if (!sub) {
        return { available: false, note: 'The API key has no user-read scope, so quota cannot be read.' };
      }

      const used = Number(sub.character_count ?? 0);
      const limit = Number(sub.character_limit ?? 0);
      return {
        available: true,
        tier: sub.tier,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        percentUsed: limit ? Math.round((used / limit) * 1000) / 10 : null,
        resetsAt: sub.next_character_count_reset_unix
          ? new Date(Number(sub.next_character_count_reset_unix) * 1000).toISOString()
          : null,
      };
    });

    /**
     * Where the credits went. The subscription total says how much is gone but
     * not what spent it, and on an agent the answer is almost always "speech",
     * split across a greeting that plays on every single session and the
     * replies themselves.
     */
    app.get('/api/diagnostics/usage', async (req, reply) => {
      const query = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).safeParse(req.query ?? {});
      if (!query.success) return reply.code(400).send({ error: 'Invalid query' });

      const settings = await ctx.store.load();
      if (!settings.elevenlabsApiKey) return reply.code(400).send({ error: 'No ElevenLabs API key configured' });
      const client = new ElevenLabsClient(settings.elevenlabsApiKey);

      const end = Date.now();
      const start = end - query.data.days * 86_400_000;
      const [total, byVoice, byModel] = await Promise.all([
        client.characterStats(start, end),
        client.characterStats(start, end, 'voice'),
        client.characterStats(start, end, 'model'),
      ]);

      // What each session costs before anyone says anything: the greeting is
      // synthesised every time a session starts.
      const firstMessage = settings.agent.firstMessage ?? '';

      const agentId = settings.provisioned.agentId;
      const conversations = agentId ? await client.listConversations(agentId, 20) : [];
      const durations = conversations.map((c) => c.call_duration_secs ?? 0).filter((d) => d > 0);

      return {
        windowDays: query.data.days,
        total,
        byVoice,
        byModel,
        greeting: { text: firstMessage, characters: firstMessage.length },
        conversations: {
          sampled: durations.length,
          totalSecs: durations.reduce((a, b) => a + b, 0),
          medianSecs: durations.length
            ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]
            : null,
        },
        ttsModel: settings.voice.modelId,
      };
    });

    app.get('/api/diagnostics/conversations', async (req, reply) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(20).default(5), full: z.coerce.boolean().default(false) })
        .safeParse(req.query ?? {});
      if (!query.success) return reply.code(400).send({ error: 'Invalid query' });

      const settings = await ctx.store.load();
      if (!settings.elevenlabsApiKey) return reply.code(400).send({ error: 'No ElevenLabs API key configured' });
      const agentId = settings.provisioned.agentId;
      if (!agentId) return reply.code(400).send({ error: 'Agent has not been provisioned' });

      const client = new ElevenLabsClient(settings.elevenlabsApiKey);
      const summaries = await client.listConversations(agentId, query.data.limit);

      const details = await Promise.all(
        summaries.map(async (s) => {
          try {
            const detail = await client.getConversation(s.conversation_id);
            const turns = detail.transcript ?? [];
            return {
              id: s.conversation_id,
              status: detail.status ?? s.status,
              durationSecs: detail.metadata?.call_duration_secs ?? s.call_duration_secs,
              terminationReason: detail.metadata?.termination_reason ?? null,
              callSuccessful: s.call_successful,
              turnCount: turns.length,
              // Which tools were actually invoked, and whether they errored —
              // the question a transcript answers and a request log cannot.
              toolCalls: turns.flatMap((t) =>
                (t.tool_calls ?? []).map((c) => ({
                  tool: c.tool_name,
                  atSecs: t.time_in_call_secs,
                  args: c.params_as_json?.slice(0, 200),
                })),
              ),
              toolErrors: turns.flatMap((t) =>
                (t.tool_results ?? [])
                  .filter((r) => r.is_error)
                  .map((r) => ({ tool: r.tool_name, result: r.result_value?.slice(0, 300) })),
              ),
              transcript: query.data.full
                ? turns.map((t) => ({
                    role: t.role,
                    atSecs: t.time_in_call_secs,
                    message: t.message?.slice(0, 400) ?? null,
                  }))
                : turns.slice(-6).map((t) => ({
                    role: t.role,
                    atSecs: t.time_in_call_secs,
                    message: t.message?.slice(0, 200) ?? null,
                  })),
            };
          } catch (err) {
            return { id: s.conversation_id, error: (err as Error).message };
          }
        }),
      );

      return { agentId, conversations: details };
    });
  };
