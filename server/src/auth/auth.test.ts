import { describe, expect, it } from 'vitest';
import { BASE_LOCK_MS, LoginLimiter, MAX_FAILURES, MAX_LOCK_MS } from './limiter.js';
import { hashPassword, isPasswordHash, verifyPassword } from './password.js';
import { readCookie, SESSION_TTL_MS, SessionSigner } from './session.js';

describe('password hashes', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', hash)).toBe(false);
  });

  it('never contains a `$`, which Coolify interpolation would eat', async () => {
    const hash = await hashPassword('x'.repeat(20));
    expect(hash).not.toContain('$');
    expect(isPasswordHash(hash)).toBe(true);
  });

  it('treats a malformed hash as never matching', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('session cookies', () => {
  const signer = new SessionSigner('master-key');

  it('round-trips the username', () => {
    expect(signer.verify(signer.issue('ops', 'h1'), 'h1')).toBe('ops');
  });

  it('rejects a tampered token', () => {
    const token = signer.issue('ops', 'h1');
    const forged = `${Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 1e9, pw: SessionSigner.fingerprint('h1') })).toString('base64url')}.${token.split('.')[1]}`;
    expect(signer.verify(forged, 'h1')).toBeNull();
  });

  it('rejects a token signed with another key', () => {
    expect(new SessionSigner('other-key').verify(signer.issue('ops', 'h1'), 'h1')).toBeNull();
  });

  it('expires', () => {
    const issued = 1_000_000;
    const token = signer.issue('ops', 'h1', issued);
    expect(signer.verify(token, 'h1', issued + SESSION_TTL_MS - 1)).toBe('ops');
    expect(signer.verify(token, 'h1', issued + SESSION_TTL_MS)).toBeNull();
  });

  it('is revoked by a password change', () => {
    expect(signer.verify(signer.issue('ops', 'h1'), 'h2')).toBeNull();
  });

  it('reads its cookie out of a header with others', () => {
    expect(readCookie('a=1; srevoice_session=abc.def; b=2', 'srevoice_session')).toBe('abc.def');
    expect(readCookie(undefined, 'srevoice_session')).toBeUndefined();
  });
});

describe('login limiter', () => {
  it(`locks an address after ${MAX_FAILURES} failures`, () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < MAX_FAILURES - 1; i++) expect(limiter.fail('1.1.1.1', 0)).toBe(0);
    expect(limiter.fail('1.1.1.1', 0)).toBe(BASE_LOCK_MS);
    expect(limiter.lockedFor('2.2.2.2', 0)).toBe(0);
  });

  it('doubles the lock each time, up to the cap', () => {
    const limiter = new LoginLimiter();
    let now = 0;
    const locks: number[] = [];
    for (let round = 0; round < 6; round++) {
      let lock = 0;
      for (let i = 0; i < MAX_FAILURES; i++) lock = limiter.fail('1.1.1.1', now);
      locks.push(lock);
      now += lock;
    }
    expect(locks.slice(0, 3)).toEqual([BASE_LOCK_MS, BASE_LOCK_MS * 2, BASE_LOCK_MS * 4]);
    expect(Math.max(...locks)).toBe(MAX_LOCK_MS);
  });

  it('forgives failures on a successful sign-in', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < MAX_FAILURES - 1; i++) limiter.fail('1.1.1.1', 0);
    limiter.succeed('1.1.1.1');
    expect(limiter.fail('1.1.1.1', 0)).toBe(0);
  });

  it('slows everyone down as failures pile up anywhere, without locking anyone', () => {
    const limiter = new LoginLimiter();
    expect(limiter.delayFor(0)).toBe(0);
    for (let i = 0; i < 10; i++) limiter.fail(`10.0.0.${i}`, 0);
    expect(limiter.delayFor(0)).toBeGreaterThan(0);
    expect(limiter.lockedFor('10.0.0.1', 0)).toBe(0);
  });
});
