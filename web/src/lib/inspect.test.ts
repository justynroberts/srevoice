import { describe, expect, it } from 'vitest';
import { classify } from './inspect';

describe('classify — choosing a readable rendering', () => {
  it('treats a list of strings as prose, not a JSON array', () => {
    // screen__show passes plain-text rows; rendering them quoted and bracketed
    // is the least readable option available.
    const shape = classify(['- checkout-api is down', '- payments is degraded']);
    expect(shape.kind).toBe('lines');
  });

  it('still treats a list of objects as structured data', () => {
    const shape = classify([{ id: 'P1', name: 'one' }, { id: 'P2', name: 'two' }]);
    expect(shape.kind).toBe('table');
  });

  it('keeps the heading from a screen__show payload', () => {
    const shape = classify({ title: 'Triggered P1s', note: '3 of 47', items: ['a', 'b'] });
    expect(shape).toMatchObject({ kind: 'titled', title: 'Triggered P1s', note: '3 of 47' });
  });

  it('recognises incidents inside a wrapper object', () => {
    const shape = classify({
      incidents: [
        { id: 'P1', title: 'Checkout 500s', status: 'triggered', urgency: 'high' },
      ],
    });
    expect(shape.kind).toBe('incidents');
  });

  it('reports an empty collection as empty rather than an empty table', () => {
    expect(classify({ incidents: [] }).kind).toBe('empty');
    expect(classify([]).kind).toBe('empty');
  });
});

describe('classify — HTTP envelopes', () => {
  // What rd__api_call actually returns: a JSON document, as a string, whose
  // useful part is buried under twenty response headers.
  const raw = JSON.stringify({
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'JSESSIONID=abc' },
    body: [{ name: 'TravelDuty', description: '' }],
  });

  it('parses a JSON document that arrived as a string', () => {
    expect(classify(raw).kind).toBe('http');
  });

  it('says what the status means instead of showing the code alone', () => {
    expect(classify(raw)).toMatchObject({ kind: 'http', status: 200, ok: true, summary: 'Worked' });
  });

  it('separates headers from the body so the body can be rendered on its own', () => {
    const shape = classify(raw);
    if (shape.kind !== 'http') throw new Error('expected an http shape');
    expect(shape.headers).toHaveLength(2);
    expect(shape.body).toEqual([{ name: 'TravelDuty', description: '' }]);
  });

  it('marks a failure as not ok and explains it in words', () => {
    const shape = classify({ status: 403, headers: {}, body: null });
    expect(shape).toMatchObject({ kind: 'http', ok: false });
    if (shape.kind === 'http') expect(shape.summary).toMatch(/not allowed/i);
  });

  it('unwraps a body that is itself a JSON string', () => {
    const shape = classify({ status: 200, body: '{"name":"TravelDuty"}' });
    if (shape.kind !== 'http') throw new Error('expected an http shape');
    expect(shape.body).toEqual({ name: 'TravelDuty' });
  });

  it('leaves ordinary objects that merely have a status field alone', () => {
    // An incident has a status too — a string one. Only a numeric HTTP code
    // alongside a body or headers should trigger the envelope view.
    expect(classify({ status: 'triggered', title: 'Checkout 500s', urgency: 'high' }).kind).toBe(
      'incidents',
    );
  });

  it('does not mistake a plain sentence for JSON', () => {
    expect(classify('Everything is fine right now.').kind).toBe('text');
  });
});
