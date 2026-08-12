import { describe, expect, it } from 'vitest';
import { normaliseToolParameters } from './schema.js';

describe('normaliseToolParameters', () => {
  it('passes a simple object schema through', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Incident status', enum: ['triggered', 'resolved'] },
        limit: { type: 'integer' },
      },
      required: ['status'],
    });

    expect(out.type).toBe('object');
    expect((out.properties as Record<string, unknown>).status).toMatchObject({
      type: 'string',
      enum: ['triggered', 'resolved'],
    });
    expect(out.required).toEqual(['status']);
  });

  it('collapses a nullable union to the concrete type', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: { since: { type: ['string', 'null'] } },
    });
    expect((out.properties as Record<string, { type: string }>).since.type).toBe('string');
  });

  it('resolves anyOf to its first usable branch', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: { id: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    });
    expect((out.properties as Record<string, { type: string }>).id.type).toBe('string');
  });

  it('drops required entries that have no matching property', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a', 'ghost'],
    });
    expect(out.required).toEqual(['a']);
  });

  it('flattens deep nesting into a JSON string field rather than dropping it', () => {
    const deep = {
      type: 'object',
      properties: {
        l1: {
          type: 'object',
          properties: {
            l2: {
              type: 'object',
              properties: {
                l3: { type: 'object', properties: { l4: { type: 'object', properties: {} } } },
              },
            },
          },
        },
      },
    };
    const out = normaliseToolParameters(deep);
    const l1 = (out.properties as Record<string, Record<string, unknown>>).l1;
    const l2 = (l1.properties as Record<string, Record<string, unknown>>).l2;
    const l3 = (l2.properties as Record<string, Record<string, unknown>>).l3;
    // Four levels survive as real objects; the fifth is where it flattens.
    expect(l3.type).toBe('object');
    const l4 = (l3.properties as Record<string, Record<string, unknown>>).l4;
    expect(l4.type).toBe('string');
    expect(String(l4.description)).toContain('JSON string');
  });

  it('always yields an object root', () => {
    expect(normaliseToolParameters({ type: 'string' })).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
    expect(normaliseToolParameters(undefined).type).toBe('object');
  });

  it('normalises array item schemas', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
    });
    const ids = (out.properties as Record<string, Record<string, unknown>>).ids;
    expect(ids.type).toBe('array');
    expect(ids.items).toMatchObject({ type: 'string' });
  });
});

describe('array items', () => {
  it('supplies described items for a bare array — ElevenLabs 422s without them', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: { examples: { type: 'array' } },
    });
    const examples = (out.properties as Record<string, Record<string, unknown>>).examples;
    expect(examples.type).toBe('array');
    // Items must carry a description or ElevenLabs rejects the whole tool.
    expect(examples.items).toMatchObject({ type: 'string' });
    expect(typeof (examples.items as Record<string, unknown>).description).toBe('string');
  });

  it('recovers items from an anyOf optional-array branch', () => {
    // The exact shape that cost two PagerDuty tools: items live inside the
    // anyOf branch, not on the node.
    const out = normaliseToolParameters({
      type: 'object',
      properties: {
        examples: {
          anyOf: [{ items: { type: 'string' }, type: 'array' }, { type: 'null' }],
          default: null,
          description: 'Optional usage examples shown when the skill is loaded.',
        },
      },
    });
    const examples = (out.properties as Record<string, Record<string, unknown>>).examples;
    expect(examples.type).toBe('array');
    const items = examples.items as Record<string, unknown>;
    expect(items.type).toBe('string');
    expect(items.description).toContain('Optional usage examples');
  });

  it('still normalises declared items', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: { ids: { type: 'array', items: { type: ['integer', 'null'] } } },
    });
    const ids = (out.properties as Record<string, Record<string, unknown>>).ids;
    expect(ids.items).toMatchObject({ type: 'integer' });
  });
});
