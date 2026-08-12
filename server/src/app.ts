import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import type { AppContext } from './context.js';
import { safeEqual } from './crypto/seal.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { mcpRoutes } from './routes/mcp.js';
import { sessionRoutes } from './routes/session.js';
import { settingsRoutes } from './routes/settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/ sits alongside the built web bundle inside the image. */
const WEB_ROOT = resolve(HERE, '../../web/dist');

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Cast keeps the instance on Fastify's default generics — passing a
    // concrete pino Logger otherwise widens every route type downstream.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  // Treat an empty JSON body as `{}`. Several routes take no body at all, and
  // Fastify's default parser 400s on `content-type: application/json` with
  // nothing after it — a failure that looks like a bad request from the
  // operator rather than a bodyless POST.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      if (!body || body.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  await app.register(cors, {
    origin: resolveCorsOrigins(),
    credentials: true,
    allowedHeaders: ['content-type', 'x-srevoice-token'],
  });

  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
    // A busy conversation fires several tool calls per turn; the limit exists
    // to stop runaway loops, not to pace normal use.
    allowList: (req) => req.url === '/api/health',
  });

  if (env.SREVOICE_ACCESS_TOKEN) {
    const expected = env.SREVOICE_ACCESS_TOKEN;
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/') || req.url.startsWith('/api/health')) return;
      const supplied = req.headers['x-srevoice-token'];
      if (typeof supplied !== 'string' || !safeEqual(supplied, expected)) {
        return reply.code(401).send({ error: 'Missing or invalid console access token' });
      }
      return;
    });
  } else {
    logger.warn('SREVOICE_ACCESS_TOKEN is not set — the console API is open to anyone who can reach it.');
  }

  await app.register(healthRoutes(ctx));
  await app.register(settingsRoutes(ctx));
  await app.register(mcpRoutes(ctx));
  await app.register(sessionRoutes(ctx));

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    logger.error({ err: err.message, url: req.url, status }, 'Request failed');
    // Internal failures get a generic message — error text here can carry
    // fragments of upstream responses.
    reply.code(status).send({
      error: status >= 500 ? 'Internal server error' : err.message,
    });
  });

  await registerWebApp(app);
  return app;
}

/**
 * Serves the built SPA from the same origin as the API, so the browser needs no
 * CORS setup and no separate deployment target.
 */
async function registerWebApp(app: FastifyInstance): Promise<void> {
  if (!existsSync(WEB_ROOT)) {
    logger.warn({ WEB_ROOT }, 'Web bundle not found — running API only (expected during `npm run dev:api`)');
    return;
  }

  await app.register(fastifyStatic, { root: WEB_ROOT, index: ['index.html'] });

  // Client-side routing: anything that is not an API call or a real file falls
  // through to the SPA shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html', join(WEB_ROOT));
  });
}

function resolveCorsOrigins(): true | string[] {
  if (env.CORS_ORIGINS) return env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  // Same-origin in production; the Vite dev server needs an explicit allowance.
  return env.NODE_ENV === 'production' ? [] : true;
}
