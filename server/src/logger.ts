import pino from 'pino';
import { env } from './env.js';

const REDACTED = '[redacted]';

/**
 * Credentials move through this process constantly. Redaction is centralised
 * here so no route has to remember to strip them before logging.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-srevoice-token"]',
      'req.headers["xi-api-key"]',
      '*.elevenlabsApiKey',
      '*.headers',
      'settings.elevenlabsApiKey',
      'settings.mcpServers[*].headers',
      'signed_url',
      'signedUrl',
    ],
    censor: REDACTED,
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

/** Masks a secret for display: keeps enough to recognise it, never enough to use it. */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
