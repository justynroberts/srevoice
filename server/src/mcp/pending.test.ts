import { describe, expect, it } from 'vitest';
import { PendingCalls } from './pending.js';
import type { RenderedResult } from './render.js';

const result = (speech: string): RenderedResult => ({
  speech,
  display: { speech },
  isError: false,
  truncated: false,
});

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('PendingCalls', () => {
  it('collects a call that outran its turn', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__list', {}, Promise.resolve(result('three incidents')));
    await settle();

    const collected = pending.collectSettled();
    expect(collected).toHaveLength(1);
    expect(collected[0].result?.speech).toBe('three incidents');
  });

  it('never collects a call the request already answered inline', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__list', {}, Promise.resolve(result('answered fast')));
    await settle();
    // The route returned this result itself.
    pending.markAnsweredInline('c1');

    // Otherwise the agent hears the same answer twice.
    expect(pending.collectSettled()).toEqual([]);
  });

  it('collects each result exactly once', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__list', {}, Promise.resolve(result('once')));
    await settle();

    expect(pending.collectSettled()).toHaveLength(1);
    expect(pending.collectSettled()).toHaveLength(0);
  });

  it('reports a failure rather than dropping it', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__list', {}, Promise.reject(new Error('upstream exploded')));
    await settle();

    const [call] = pending.collectSettled();
    expect(call.error).toBe('upstream exploded');
    expect(call.result).toBeUndefined();
  });

  it('lists what is still running', async () => {
    const pending = new PendingCalls();
    let release: (r: RenderedResult) => void = () => {};
    pending.track('slow', 'pd__big', {}, new Promise<RenderedResult>((r) => { release = r; }));

    expect(pending.outstanding().map((c) => c.tool)).toEqual(['pd__big']);
    release(result('done'));
    await settle();
    expect(pending.outstanding()).toEqual([]);
  });
});
