import { z } from 'zod';
import { isPasswordHash } from './auth/password.js';

/**
 * Only infrastructure lives in env. Every user-supplied credential (ElevenLabs
 * key, MCP bearer tokens) is pasted through the UI and sealed into the settings
 * store — see store/settings.ts.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5280),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Directory backed by a persistent volume in production. */
  DATA_DIR: z.string().default('./.data'),

  /**
   * 32-byte key, base64 or hex, used to seal the settings file at rest.
   * Required in production: without it a restart would silently orphan every
   * stored credential.
   */
  SREVOICE_MASTER_KEY: z.string().optional(),

  /**
   * Shared secret for the console itself. When set, every /api route (except
   * /api/health) requires `x-srevoice-token`. Strongly recommended once the
   * app is public on Coolify.
   */
  SREVOICE_ACCESS_TOKEN: z.string().optional(),

  /**
   * Console sign-in. Set both to require a username and password for the whole
   * console; generate the hash with `npm run hash-password --workspace server`.
   */
  SREVOICE_USERNAME: z.string().min(1).optional(),
  SREVOICE_PASSWORD_HASH: z.string().min(1).optional(),

  /**
   * How many reverse proxies sit in front of the app. The client address is
   * taken from that many hops back in X-Forwarded-For — trusting the whole
   * header would let anyone pick their own IP and walk past every per-IP limit.
   * Coolify's Traefik is one hop; set 0 when nothing proxies the app.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  /** Comma-separated extra CORS origins for local development. */
  CORS_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  const env = parsed.data;

  // Half a login configuration would leave the console open while looking locked.
  if (Boolean(env.SREVOICE_USERNAME) !== Boolean(env.SREVOICE_PASSWORD_HASH)) {
    throw new Error('Set both SREVOICE_USERNAME and SREVOICE_PASSWORD_HASH, or neither.');
  }
  if (env.SREVOICE_PASSWORD_HASH && !isPasswordHash(env.SREVOICE_PASSWORD_HASH)) {
    throw new Error(
      'SREVOICE_PASSWORD_HASH is not a valid hash. Generate one with: npm run hash-password --workspace server',
    );
  }

  if (env.NODE_ENV === 'production' && !env.SREVOICE_MASTER_KEY) {
    throw new Error(
      'SREVOICE_MASTER_KEY is required in production. Generate one with: openssl rand -base64 32',
    );
  }
  return env;
}

export const env = loadEnv();
