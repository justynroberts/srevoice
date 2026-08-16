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

describe('a late result belongs to one conversation only', () => {
  const done = (speech: string) =>
    Promise.resolve({ speech, display: null, isError: false, truncated: false });

  it('is not handed to the session that comes after it', async () => {
    // A post-remediation check settles ninety seconds later, long after a demo
    // session has ended. Without scoping, the next session's first poll
    // collects it and the agent announces an answer to a question nobody in
    // the room asked.
    const pending = new PendingCalls();
    pending.track('c1', 'mcp2__incident_followup', {}, done('The remediation worked'), 'session-a');
    await new Promise((r) => setTimeout(r, 5));

    expect(pending.collectSettled('session-b')).toHaveLength(0);
  });

  it('is dropped rather than left to surface later', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__slow', {}, done('late'), 'session-a');
    await new Promise((r) => setTimeout(r, 5));

    pending.collectSettled('session-b');
    // Even the session it belonged to must not get it now — it has moved on.
    expect(pending.collectSettled('session-a')).toHaveLength(0);
  });

  it('still reaches the conversation that asked', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__slow', {}, done('here it is'), 'session-a');
    await new Promise((r) => setTimeout(r, 5));

    const [call] = pending.collectSettled('session-a');
    expect(call.result?.speech).toBe('here it is');
  });

  it('survives a reconnect, which keeps the same id', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__slow', {}, done('resumed'), 'session-a');
    await new Promise((r) => setTimeout(r, 5));
    // The browser reconnected; same conversation, same id, so the answer lands.
    expect(pending.collectSettled('session-a')).toHaveLength(1);
  });

  it('keeps working for calls tracked without a session', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__slow', {}, done('legacy'));
    await new Promise((r) => setTimeout(r, 5));
    expect(pending.collectSettled('session-a')).toHaveLength(1);
  });

  it('hides another session\'s outstanding work from the count', async () => {
    const pending = new PendingCalls();
    pending.track('c1', 'pd__slow', {}, new Promise(() => {}), 'session-a');
    expect(pending.outstanding('session-b')).toHaveLength(0);
    expect(pending.outstanding('session-a')).toHaveLength(1);
  });
});
