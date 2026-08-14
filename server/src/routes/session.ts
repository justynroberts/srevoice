import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context.js';
import { ElevenLabsClient, ElevenLabsError } from '../elevenlabs/api.js';
import { provision, ProvisionError } from '../elevenlabs/provision.js';

export const sessionRoutes = (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    /**
     * Rebuilds the ElevenLabs agent from the current MCP catalogue. Safe to run
     * repeatedly — it reconciles rather than recreating.
     */
    app.post('/api/provision', async (_req, reply) => {
      try {
        const settings = await ctx.store.load();
        // Reconnect first: provisioning against a stale catalogue would
        // register tools that no longer exist.
        await ctx.pool.sync(settings.mcpServers);
        const report = await provision(ctx.store, ctx.pool, ctx.skills);
        return { ...report, servers: ctx.pool.status() };
      } catch (err) {
        if (err instanceof ProvisionError) return reply.code(400).send({ error: err.message });
        if (err instanceof ElevenLabsError) {
          return reply.code(err.isAuthFailure ? 401 : 502).send({ error: err.message });
        }
        throw err;
      }
    });

    /**
     * Mints a short-lived signed URL for the browser's WebSocket. The
     * ElevenLabs key stays here; the browser only ever holds the signature.
     */
    app.post('/api/session/start', async (_req, reply) => {
      const settings = await ctx.store.load();

      if (!settings.elevenlabsApiKey) {
        return reply.code(409).send({ error: 'No ElevenLabs API key configured.', needs: 'apiKey' });
      }
      if (!settings.provisioned.agentId) {
        return reply.code(409).send({ error: 'The voice agent has not been provisioned yet.', needs: 'provision' });
      }

      try {
        const client = new ElevenLabsClient(settings.elevenlabsApiKey);
        const signedUrl = await client.getSignedUrl(settings.provisioned.agentId);
        return {
          signedUrl,
          agentId: settings.provisioned.agentId,
          tools: ctx.pool.catalogue().map((t) => t.qualifiedName),
        };
      } catch (err) {
        if (err instanceof ElevenLabsError) {
          if (err.status === 404) {
            return reply.code(409).send({
              error: 'The provisioned agent no longer exists in ElevenLabs. Re-provision from Settings.',
              needs: 'provision',
            });
          }
          return reply.code(err.isAuthFailure ? 401 : 502).send({ error: err.message });
        }
        throw err;
      }
    });
  };
