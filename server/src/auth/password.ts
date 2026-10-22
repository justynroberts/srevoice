import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/**
 * Password hashes for the console login, in the form
 *
 *   scrypt.<N>.<r>.<p>.<salt>.<hash>      (salt and hash base64url)
 *
 * Dots rather than the usual `$` separators on purpose: the hash lives in a
 * Coolify environment variable, and Coolify passes values through compose
 * interpolation, which reads `$32768` as a variable and silently deletes it.
 * The symptom would be that the correct password is always rejected.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 32;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('.');
}

export function isPasswordHash(value: string): boolean {
  return /^scrypt\.\d+\.\d+\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/** Constant-time; a malformed hash simply never verifies. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!isPasswordHash(stored)) return false;
  const [, n, r, p, salt, hash] = stored.split('.');
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
