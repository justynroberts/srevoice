import { logger } from '../logger.js';
import type { RenderedResult } from './render.js';

/** How long a finished result is kept for collection before it is dropped. */
const RETAIN_MS = 15 * 60_000;

export interface PendingCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  startedAt: number;
  settledAt?: number;
  result?: RenderedResult & { durationMs: number };
  error?: string;
  /** True once the browser has collected it — kept briefly for idempotent polls. */
  collected?: boolean;
  /**
   * True when the originating request answered with the result inline. Such a
   * call must never be collected again, or the agent hears the same answer
   * twice — once as a tool result and once as a late arrival.
   */
  answeredInline?: boolean;
}

/**
 * Tool calls that outran the conversation turn that started them.
 *
 * ElevenLabs will wait at most two minutes for a client tool, and an engineer
 * talking over the agent ends the turn sooner than that. Either way the work
 * itself is still running server-side, and its answer is still wanted — so the
 * call is tracked here and collected afterwards rather than thrown away.
 */
export class PendingCalls {
  private calls = new Map<string, PendingCall>();

  track(callId: string, tool: string, args: Record<string, unknown>, work: Promise<RenderedResult>): void {
    const startedAt = Date.now();
    this.calls.set(callId, { callId, tool, args, startedAt });

    void work
      .then((result) => {
        this.settle(callId, { result: { ...result, durationMs: Date.now() - startedAt } });
      })
      .catch((err: unknown) => {
        this.settle(callId, { error: err instanceof Error ? err.message : String(err) });
      });
  }

  private settle(callId: string, patch: Partial<PendingCall>): void {
    const call = this.calls.get(callId);
    if (!call) return;
    this.calls.set(callId, { ...call, ...patch, settledAt: Date.now() });
    logger.info(
      { callId, tool: call.tool, durationMs: Date.now() - call.startedAt },
      'Long-running tool call finished',
    );
    this.sweep();
  }

  get(callId: string): PendingCall | undefined {
    return this.calls.get(callId);
  }

  /** The originating request returned this result itself — do not re-announce it. */
  markAnsweredInline(callId: string): void {
    const call = this.calls.get(callId);
    if (call) this.calls.set(callId, { ...call, answeredInline: true });
  }

  /**
   * Everything that has finished since the caller last asked. Marking on
   * collection rather than deleting keeps a repeated poll idempotent, which
   * matters when the browser reconnects and re-polls.
   */
  collectSettled(): PendingCall[] {
    const ready: PendingCall[] = [];
    for (const call of this.calls.values()) {
      if (call.settledAt && !call.collected && !call.answeredInline) {
        this.calls.set(call.callId, { ...call, collected: true });
        ready.push(call);
      }
    }
    return ready;
  }

  outstanding(): PendingCall[] {
    return [...this.calls.values()].filter((c) => !c.settledAt);
  }

  private sweep(): void {
    const cutoff = Date.now() - RETAIN_MS;
    for (const [id, call] of this.calls) {
      if (call.settledAt && call.settledAt < cutoff) this.calls.delete(id);
    }
  }
}
