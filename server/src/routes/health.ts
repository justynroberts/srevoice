import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context.js';

export const healthRoutes = (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    /** Liveness only — never touches credentials, safe to expose unauthenticated. */
    app.get('/api/health', async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }));

    /** Readiness: is this console actually able to hold a conversation? */
    app.get('/api/health/ready', async (_req, reply) => {
      const settings = await ctx.store.load();
      const servers = ctx.pool.status();
      const ready = Boolean(settings.elevenlabsApiKey && settings.provisioned.agentId);

      const body = {
        status: ready ? 'ready' : 'unconfigured',
        elevenlabsConfigured: Boolean(settings.elevenlabsApiKey),
        agentProvisioned: Boolean(settings.provisioned.agentId),
        mcpServers: servers.map((s) => ({ id: s.id, state: s.state, toolCount: s.toolCount })),
        toolCount: ctx.pool.catalogue().length,
      };
      // 503 while unconfigured would make Coolify's health check flap before
      // the operator has had a chance to paste any keys.
      return reply.code(200).send(body);
    });
  };
