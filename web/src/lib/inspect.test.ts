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
