import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveKey, open, safeEqual, seal, SealError } from './seal.js';

describe('deriveKey', () => {
  it('uses 32-byte hex material directly', () => {
    const hex = randomBytes(32).toString('hex');
    expect(deriveKey(hex).toString('hex')).toBe(hex);
  });

  it('uses 32-byte base64 material directly', () => {
    const raw = randomBytes(32);
    expect(deriveKey(raw.toString('base64')).equals(raw)).toBe(true);
  });

  it('hashes an arbitrary passphrase to a usable key', () => {
    const key = deriveKey('correct horse battery staple');
    expect(key).toHaveLength(32);
    // Stable, so a restart with the same passphrase can still decrypt.
    expect(deriveKey('correct horse battery staple').equals(key)).toBe(true);
  });

  it('rejects empty material', () => {
    expect(() => deriveKey('   ')).toThrow(SealError);
  });
});

describe('seal / open', () => {
  const key = deriveKey(randomBytes(32).toString('base64'));

  it('round-trips a payload', () => {
    const secret = JSON.stringify({ apiKey: 'sk_live_abc', nested: { token: 'Bearer xyz' } });
    expect(open(seal(secret, key), key)).toBe(secret);
  });

  it('produces a different envelope each time', () => {
    expect(seal('same', key)).not.toBe(seal('same', key));
  });

  it('fails with the wrong key rather than returning garbage', () => {
    const envelope = seal('secret', key);
    const other = deriveKey(randomBytes(32).toString('base64'));
    expect(() => open(envelope, other)).toThrow(/does not match/);
  });

  it('detects tampering with the ciphertext', () => {
    const parts = seal('secret payload here', key).split('.');
    const bytes = Buffer.from(parts[2], 'base64url');
    bytes[0] ^= 0xff;
    parts[2] = bytes.toString('base64url');
    expect(() => open(parts.join('.'), key)).toThrow(SealError);
  });

  it('rejects a file that is not a srevoice envelope', () => {
    expect(() => open('{"apiKey":"plaintext"}', key)).toThrow(/not a srevoice sealed envelope/i);
  });
});

describe('safeEqual', () => {
  it('matches identical strings and rejects everything else', () => {
    expect(safeEqual('token-abc', 'token-abc')).toBe(true);
    expect(safeEqual('token-abc', 'token-abd')).toBe(false);
    expect(safeEqual('short', 'much longer value')).toBe(false);
  });
});
