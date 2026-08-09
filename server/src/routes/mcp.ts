import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { logger } from '../logger.js';
import { renderToolResult } from '../mcp/render.js';

const callBody = z.object({
  tool: z.string().min(1).max(128),
  args: z.record(z.unknown()).default({}),
  /** Correlates a call with a turn in the transcript for the UI. */
  callId: z.string().max(128).optional(),
});

export const mcpRoutes = (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/mcp/status', async () => ({
      servers: ctx.pool.status(),
      toolCount: ctx.pool.catalogue().length,
    }));

    app.get('/api/mcp/catalogue', async () => ({
      tools: ctx.pool.catalogue().map((t) => ({
        name: t.qualifiedName,
        server: t.serverLabel,
        serverId: t.serverId,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
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
     * The bridge the voice agent's client tools call through. Returns both the
     * short text the agent speaks from and the full payload the screen renders,
     * so one round trip feeds both output channels.
     *
     * Tool failures deliberately return 200 with `isError`. A 4xx/5xx here
     * would surface to the agent as a broken tool rather than as a result it
     * can reason about and explain out loud.
     */
    app.post('/api/mcp/call', async (req, reply) => {
      const parsed = callBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid tool call', issues: parsed.error.issues });
      }
      const { tool, args, callId } = parsed.data;
      const startedAt = Date.now();

      try {
        const raw = await ctx.pool.call(tool, args);
        const rendered = renderToolResult(raw);
        const durationMs = Date.now() - startedAt;

        logger.info({ tool, durationMs, isError: rendered.isError }, 'MCP tool call complete');
        return {
          callId,
          tool,
          args,
          ok: !rendered.isError,
          speech: rendered.speech,
          display: rendered.display,
          truncated: rendered.truncated,
          durationMs,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startedAt;
        logger.error({ tool, err: message, durationMs }, 'MCP tool call failed');

        return {
          callId,
          tool,
          args,
          ok: false,
          speech: `The ${tool} tool failed: ${message}`,
          display: { error: message },
          truncated: false,
          durationMs,
        };
      }
    });
  };
