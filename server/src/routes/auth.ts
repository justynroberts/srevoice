import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../auth/password.js';
import { LoginLimiter } from '../auth/limiter.js';
import { readCookie, SESSION_COOKIE, sessionCookie, SessionSigner } from '../auth/session.js';
import { env } from '../env.js';
import { logger } from '../logger.js';

export interface AuthConfig {
  username: string;
  passwordHash: string;
}

/** Login is on when both halves are configured; env.ts refuses one without the other. */
export const authConfig: AuthConfig | null =
  env.SREVOICE_USERNAME && env.SREVOICE_PASSWORD_HASH
    ? { username: env.SREVOICE_USERNAME, passwordHash: env.SREVOICE_PASSWORD_HASH }
    : null;

const signer = new SessionSigner(env.SREVOICE_MASTER_KEY);
const limiter = new LoginLimiter();
const secureCookies = env.NODE_ENV === 'production';

/** The signed-in username for this request, or null. */
export function sessionUser(req: FastifyRequest): string | null {
  if (!authConfig) return null;
  return signer.verify(readCookie(req.headers.cookie, SESSION_COOKIE), authConfig.passwordHash);
}

const loginBody = z.object({
  username: z.string().max(200),
  password: z.string().max(1000),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function locked(reply: FastifyReply, ms: number) {
  const minutes = Math.ceil(ms / 60_000);
  return reply
    .code(429)
    .header('retry-after', String(Math.ceil(ms / 1000)))
    .send({
      error: `Too many failed sign-ins from this address. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      retryAfterSeconds: Math.ceil(ms / 1000),
    });
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/auth/me', async (req) => {
    const username = sessionUser(req);
    return { required: authConfig !== null, authenticated: authConfig === null || username !== null, username };
  });

  app.post(
    '/api/auth/login',
    // On top of the global limit: nobody signs in ten times a minute.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!authConfig) return reply.code(404).send({ error: 'Sign-in is not enabled on this console.' });

      const ip = req.ip;
      const wait = limiter.lockedFor(ip);
      if (wait) return locked(reply, wait);

      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Username and password are required.' });

      await sleep(limiter.delayFor());

      // Always run the hash, even for a wrong username, so response time says
      // nothing about which half was wrong.
      const passwordOk = await verifyPassword(parsed.data.password, authConfig.passwordHash);
      const userOk = parsed.data.username.trim().toLowerCase() === authConfig.username.toLowerCase();

      if (!passwordOk || !userOk) {
        const lock = limiter.fail(ip);
        logger.warn({ ip, locked: lock > 0 }, 'Failed console sign-in');
        if (lock) return locked(reply, lock);
        return reply.code(401).send({ error: 'Wrong username or password.' });
      }

      limiter.succeed(ip);
      logger.info({ ip }, 'Console sign-in');
      reply.header('set-cookie', sessionCookie(signer.issue(authConfig.username, authConfig.passwordHash), secureCookies));
      return { authenticated: true, username: authConfig.username };
    },
  );

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', sessionCookie('', secureCookies, 0));
    return { authenticated: false };
  });
};
