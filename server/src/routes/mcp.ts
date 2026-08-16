import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { logger } from '../logger.js';
import { renderToolResult, type RenderedResult } from '../mcp/render.js';
import { MEMORY_TOOLS, runMemoryTool, isMemoryTool } from '../memory/tools.js';
import { guardToolCall, recordAuthorship } from '../mcp/guard.js';
import { scheduleRemediationFollowUp } from '../mcp/followup.js';

/**
 * How long the browser waits before answering the agent with "still working".
 * Comfortably inside ElevenLabs' 120s client-tool ceiling, and short enough
 * that she does not sit mute while a slow query runs.
 */
// Most of ElevenLabs' 120s client-tool ceiling, so a merely slow query is
// answered in the same turn rather than deferred. Only genuinely long work
// falls through to the pending path.
const SOFT_BUDGET_MS = 100_000;

const callBody = z.object({
  tool: z.string().min(1).max(128),
  args: z.record(z.unknown()).default({}),
  callId: z.string().max(128).optional(),
  /** Which conversation asked, so a late answer is never given to another one. */
  sessionId: z.string().max(128).optional(),
});

export const mcpRoutes = (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/mcp/status', async () => ({
      servers: ctx.pool.status(),
      toolCount: ctx.pool.catalogue().length + MEMORY_TOOLS.length,
    }));

    app.get('/api/mcp/catalogue', async () => ({
      tools: [
        ...ctx.pool.catalogue().map((t) => ({
          name: t.qualifiedName,
          server: t.serverLabel,
          serverId: t.serverId,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        // Memory is presented as ordinary tools so provisioning, the browser
        // handler and the catalogue all treat it like any other capability.
        ...MEMORY_TOOLS.map((t) => ({
          name: t.name,
          server: 'Memory',
          serverId: 'memory',
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      ],
    }));

    app.post('/api/mcp/reconnect', async (req, reply) => {
      const body = z.object({ id: z.string().min(1).optional() }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'Invalid body' });

      if (body.data.id) {
        try {
          await ctx.pool.reconnect(body.data.id);
        } catch (err) {
          return reply.code(404).send({ error: (err as Error).message });
        }
      } else {
        const settings = await ctx.store.load();
        await ctx.pool.sync(settings.mcpServers);
      }
      return { servers: ctx.pool.status(), toolCount: ctx.pool.catalogue().length };
    });

    /**
     * The bridge the voice agent's client tools call through.
     *
     * A call that finishes inside the soft budget answers normally. One that
     * does not returns `pending`, keeps running server-side, and is collected
     * afterwards from /api/mcp/pending — so an interruption, or a query that
     * simply takes minutes, no longer throws the answer away.
     *
     * Failures deliberately return 200 with `ok: false`: a 4xx would surface to
     * the agent as a broken tool rather than a result she can explain out loud.
     */
    app.post('/api/mcp/call', async (req, reply) => {
      const parsed = callBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid tool call', issues: parsed.error.issues });
      }
      const { tool, args, sessionId } = parsed.data;
      const callId = parsed.data.callId ?? `call-${Date.now()}`;
      const startedAt = Date.now();

      // The agent may start a workflow someone approved in advance; it may not
      // run an automation job it wrote itself. Checked here rather than in the
      // prompt, because a rule that matters cannot depend on the agent
      // choosing to honour it.
      const refused = await guardToolCall(ctx.authored, tool, args);
      if (refused) {
        logger.warn({ tool, args }, 'Refused an agent-authored execution');
        return {
          callId,
          tool,
          args,
          ok: true,
          pending: false,
          speech: refused.speech,
          display: refused.display,
          truncated: false,
          durationMs: Date.now() - startedAt,
        };
      }

      const work: Promise<RenderedResult> = isMemoryTool(tool)
        ? runMemoryTool(ctx, tool, args)
        : ctx.pool.call(tool, args).then(async (raw) => {
            const rendered = renderToolResult(raw);
            // Remember anything it just created, so a later session — which
            // knows nothing of this one — still refuses to run it.
            await recordAuthorship(ctx.authored, tool, args, rendered);
            // "Started the rollback" is not "the rollback worked". Go back and
            // look, rather than leaving the engineer to remember to ask.
            if (!rendered.isError) {
              scheduleRemediationFollowUp(ctx.pool, ctx.pending, tool, args, undefined, sessionId);
            }
            return rendered;
          });

      // Register before racing, so a call that outruns the budget is already
      // tracked and nothing depends on this request surviving.
      ctx.pending.track(callId, tool, args, work, sessionId);

      const outcome = await Promise.race([
        work.then((r) => ({ done: true as const, r })).catch((e: unknown) => ({ done: true as const, e })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), SOFT_BUDGET_MS)),
      ]);

      if (!outcome.done) {
        logger.info({ tool, callId }, 'Tool call exceeded the soft budget — answering as pending');
        return {
          callId,
          tool,
          args,
          ok: true,
          pending: true,
          speech:
            `Still working on ${tool}. It is taking longer than usual — I will tell you the moment it lands, ` +
            `so carry on and I will interrupt with the answer.`,
          display: null,
          truncated: false,
          durationMs: Date.now() - startedAt,
        };
      }

      // Answered within the turn — the agent already has it.
      ctx.pending.markAnsweredInline(callId);

      if ('e' in outcome) {
        const message = outcome.e instanceof Error ? outcome.e.message : String(outcome.e);
        logger.error({ tool, err: message }, 'MCP tool call failed');
        return {
          callId,
          tool,
          args,
          ok: false,
          pending: false,
          speech: `The ${tool} tool failed: ${message}`,
          display: { error: message },
          truncated: false,
          durationMs: Date.now() - startedAt,
        };
      }

      const rendered = outcome.r;
      logger.info({ tool, durationMs: Date.now() - startedAt, isError: rendered.isError }, 'MCP tool call complete');
      return {
        callId,
        tool,
        args,
        ok: !rendered.isError,
        pending: false,
        speech: rendered.speech,
        display: rendered.display,
        truncated: rendered.truncated,
        durationMs: Date.now() - startedAt,
      };
    });

    /**
     * Results of calls that outran their turn. The browser polls this while a
     * session is live and feeds anything it finds back as a contextual update.
     */
    app.get('/api/mcp/pending', async (req) => {
      const query = z.object({ sessionId: z.string().max(128).optional() }).safeParse(req.query ?? {});
      const sessionId = query.success ? query.data.sessionId : undefined;

      const settled = ctx.pending.collectSettled(sessionId);
      return {
        outstanding: ctx.pending.outstanding(sessionId).map((c) => ({
          callId: c.callId,
          tool: c.tool,
          waitingMs: Date.now() - c.startedAt,
        })),
        settled: settled.map((c) => ({
          callId: c.callId,
          tool: c.tool,
          args: c.args,
          ok: !c.error && !c.result?.isError,
          speech: c.error ? `The ${c.tool} tool failed: ${c.error}` : (c.result?.speech ?? ''),
          display: c.error ? { error: c.error } : c.result?.display,
          truncated: c.result?.truncated ?? false,
          durationMs: c.result?.durationMs ?? 0,
        })),
      };
    });
  };
