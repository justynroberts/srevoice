/**
 * Brute-force protection for the login.
 *
 * Two layers, because they stop different attacks:
 *
 * - Per IP: five failures in fifteen minutes locks that address out, for
 *   fifteen minutes the first time and twice as long each time after, up to
 *   four hours. Stops a single machine guessing.
 * - Everyone: each recent failure, from any address, adds a little delay to
 *   every attempt. A botnet spreading guesses across thousands of IPs never
 *   trips a per-IP lock, but it still has to wait. Deliberately a delay and
 *   not a lock — a global lock would let anyone shut the real operator out.
 *
 * In memory, which is right for a single container: a restart forgets, which
 * costs an attacker nothing they could not get by waiting.
 */
export const MAX_FAILURES = 5;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const BASE_LOCK_MS = 15 * 60_000;
export const MAX_LOCK_MS = 4 * 60 * 60_000;
const DELAY_PER_GLOBAL_FAILURE_MS = 100;
const MAX_GLOBAL_DELAY_MS = 3000;
const MAX_TRACKED = 10_000;

interface IpRecord {
  failures: number[];
  lockedUntil: number;
  locks: number;
}

export class LoginLimiter {
  private readonly ips = new Map<string, IpRecord>();
  private globalFailures: number[] = [];

  /** Milliseconds the address must wait, or 0 if it may try. */
  lockedFor(ip: string, now = Date.now()): number {
    const rec = this.ips.get(ip);
    return rec && rec.lockedUntil > now ? rec.lockedUntil - now : 0;
  }

  /** Delay to apply before checking any attempt, scaled by recent failures everywhere. */
  delayFor(now = Date.now()): number {
    this.globalFailures = this.globalFailures.filter((t) => now - t < FAILURE_WINDOW_MS);
    return Math.min(MAX_GLOBAL_DELAY_MS, this.globalFailures.length * DELAY_PER_GLOBAL_FAILURE_MS);
  }

  /** Records a failure; returns the lock now in force for this address, if any. */
  fail(ip: string, now = Date.now()): number {
    this.globalFailures.push(now);
    const rec = this.ips.get(ip) ?? { failures: [], lockedUntil: 0, locks: 0 };
    rec.failures = rec.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    rec.failures.push(now);
    if (rec.failures.length >= MAX_FAILURES) {
      rec.lockedUntil = now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** rec.locks);
      rec.locks += 1;
      rec.failures = [];
    }
    this.ips.set(ip, rec);
    this.prune(now);
    return this.lockedFor(ip, now);
  }

  /** A success clears the address's failures, but not its lock history. */
  succeed(ip: string): void {
    const rec = this.ips.get(ip);
    if (rec) rec.failures = [];
  }

  private prune(now: number): void {
    if (this.ips.size <= MAX_TRACKED) return;
    for (const [ip, rec] of this.ips) {
      if (rec.lockedUntil <= now && rec.failures.every((t) => now - t >= FAILURE_WINDOW_MS)) this.ips.delete(ip);
    }
  }
}
