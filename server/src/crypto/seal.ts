import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAGIC = 'srev1';

export class SealError extends Error {}

/**
 * Accepts base64, hex, or an arbitrary passphrase. Raw 32-byte material is used
 * directly; anything else is hashed to 32 bytes so a human-typed passphrase
 * still produces a valid key rather than failing at cipher construction.
 */
export function deriveKey(material: string): Buffer {
  if (!material || material.trim().length === 0) {
    throw new SealError('Master key material is empty');
  }
  const trimmed = material.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');

  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === 32 && Buffer.from(b64).toString('base64').replace(/=+$/, '') === trimmed.replace(/=+$/, '')) {
    return b64;
  }
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

/**
 * Envelope layout: magic.iv.ciphertext.tag — all base64url, dot separated.
 * The magic prefix lets `open` reject foreign files loudly instead of
 * surfacing a confusing auth-tag failure.
 */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    MAGIC,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

export function open(envelope: string, key: Buffer): string {
  const parts = envelope.trim().split('.');
  if (parts.length !== 4 || parts[0] !== MAGIC) {
    throw new SealError('Not a srevoice sealed envelope');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const ciphertext = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SealError('Sealed envelope is malformed');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong master key, or the file was tampered with. Both are fatal and
    // indistinguishable by design.
    throw new SealError('Could not decrypt settings — SREVOICE_MASTER_KEY does not match the stored data');
  }
}

/** Constant-time compare for the console access token. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
