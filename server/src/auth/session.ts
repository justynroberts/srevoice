import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless signed session cookies. Nothing is stored server-side, so a
 * restart or a redeploy does not sign everyone out.
 *
 * Each token carries a fingerprint of the password hash it was issued under.
 * Changing the password therefore revokes every existing session — the one
 * lever an operator has if they think a session has leaked.
 */
export const SESSION_COOKIE = 'srevoice_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Payload {
  u: string;
  exp: number;
  /** Fingerprint of the password hash at issue time. */
  pw: string;
}

export class SessionSigner {
  private readonly key: Buffer;

  /** `secret` should be stable across restarts; a random one signs everyone out on boot. */
  constructor(secret: string | undefined) {
    this.key = secret
      ? createHmac('sha256', secret).update('srevoice-session-v1').digest()
      : randomBytes(32);
  }

  static fingerprint(passwordHash: string): string {
    return createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);
  }

  issue(username: string, passwordHash: string, now = Date.now()): string {
    const payload: Payload = { u: username, exp: now + SESSION_TTL_MS, pw: SessionSigner.fingerprint(passwordHash) };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /** The username, or null for anything forged, expired or issued under an old password. */
  verify(token: string | undefined, passwordHash: string, now = Date.now()): string | null {
    if (!token) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sign(body));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
      if (typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
      if (payload.exp <= now) return null;
      if (payload.pw !== SessionSigner.fingerprint(passwordHash)) return null;
      return payload.u;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function sessionCookie(value: string, secure: boolean, maxAgeMs = SESSION_TTL_MS): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Strict: the console is never reached by a cross-site link that needs to
    // arrive signed in, and it closes off cross-site request forgery.
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
