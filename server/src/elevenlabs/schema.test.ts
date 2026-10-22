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
    // Items are described from the property name, so the text stays stable
    // whether or not the parent carried a description.
    expect(items.description).toBe('Examples entry');
    // The parent keeps the description the MCP server actually supplied.
    expect(examples.description).toContain('Optional usage examples');
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

describe('descriptions are mandatory everywhere', () => {
  /** Walks the normalised schema and collects any node missing a description. */
  function undescribed(node: unknown, path = 'root'): string[] {
    if (!node || typeof node !== 'object') return [];
    const n = node as Record<string, unknown>;
    const missing: string[] = [];
    if (typeof n.type === 'string') {
      const d = n.description;
      if (typeof d !== 'string' || !d.trim()) missing.push(path);
    }
    if (n.properties && typeof n.properties === 'object') {
      for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
        missing.push(...undescribed(v, `${path}.${k}`));
      }
    }
    if (n.items) missing.push(...undescribed(n.items, `${path}[]`));
    return missing;
  }

  it('describes deeply nested object properties', () => {
    // The exact shape that cost four PagerDuty tools: create_model.schedule.type
    // and create_model.team.name were bare.
    const out = normaliseToolParameters({
      type: 'object',
      properties: {
        create_model: {
          type: 'object',
          properties: {
            schedule: {
              type: 'object',
              properties: { type: { type: 'string' }, name: { type: 'string' } },
            },
          },
        },
      },
    });
    expect(undescribed(out)).toEqual([]);

    const create = (out.properties as Record<string, Record<string, unknown>>).create_model;
    const schedule = (create.properties as Record<string, Record<string, unknown>>).schedule;
    const type = (schedule.properties as Record<string, Record<string, unknown>>).type;
    expect(type.description).toBe('Type');
  });

  it('derives readable text from snake_case and camelCase names', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: {
        escalation_policy_id: { type: 'string' },
        incidentNumber: { type: 'integer' },
      },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.escalation_policy_id.description).toBe('Escalation policy id');
    expect(props.incidentNumber.description).toBe('Incident number');
  });

  it('never leaves a node bare, whatever the shape', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: {
        bare_array: { type: 'array' },
        optional_list: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        optional_object: {
          anyOf: [{ type: 'object', properties: { id: { type: 'string' } } }, { type: 'null' }],
        },
        deep: {
          type: 'object',
          properties: { a: { type: 'object', properties: { b: { type: 'array' } } } },
        },
      },
    });
    expect(undescribed(out)).toEqual([]);
  });

  it('keeps a real description over a synthesised one', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: { status: { type: 'string', description: 'Current incident status.' } },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.status.description).toBe('Current incident status.');
  });

  describe('unions that include a string branch', () => {
    // Rundeck's api_call declares `body` as anyOf [object, array, string].
    // Taking the first branch told ElevenLabs the body was an object, so the
    // agent could not send a YAML document and reported job import as
    // impossible. A string can carry the other branches serialised; the
    // reverse is not true.
    const bodySchema = {
      type: 'object',
      properties: {
        body: {
          anyOf: [{ type: 'object' }, { type: 'array' }, { type: 'string' }],
          description: 'Request body.',
        },
      },
    };

    it('keeps the string branch so raw payloads can still be sent', () => {
      const props = normaliseToolParameters(bodySchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.body.type).toBe('string');
    });

    it('tells the agent the string has to be serialised', () => {
      const props = normaliseToolParameters(bodySchema).properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.body.description).toMatch(/serialise JSON yourself/i);
      expect((props.body.description as string).length).toBeLessThanOrEqual(500);
    });

    it('leaves the optional-value idiom alone', () => {
      // `[array, null]` and `[object, null]` have one concrete type each and
      // must keep it — collapsing those to string would break every optional
      // list and nested object in the catalogue.
      const props = normaliseToolParameters({
        type: 'object',
        properties: {
          ids: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
          filter: { anyOf: [{ type: 'object', properties: { q: { type: 'string' } } }, { type: 'null' }] },
          note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      }).properties as Record<string, Record<string, unknown>>;

      expect(props.ids.type).toBe('array');
      expect(props.filter.type).toBe('object');
      expect(props.note.type).toBe('string');
      expect(props.note.description).not.toMatch(/serialise/i);
    });
  });
});

describe('unions of object variants (one tool, several operations)', () => {
  // The shape of PagerDuty's manage_incidents: one `request` parameter whose
  // variants are told apart by `action`.
  const manageIncidents = {
    type: 'object',
    properties: {
      request: {
        oneOf: [
          {
            type: 'object',
            properties: {
              action: { const: 'create', default: 'create', type: 'string' },
              incident: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
            },
            required: ['incident'],
          },
          {
            type: 'object',
            properties: {
              action: { const: 'update', default: 'update', type: 'string' },
              manage_request: {
                type: 'object',
                properties: { incident_ids: { type: 'array', items: { type: 'string' } } },
                required: ['incident_ids'],
              },
            },
            required: ['manage_request'],
          },
          {
            type: 'object',
            properties: {
              action: { const: 'add_note', default: 'add_note', type: 'string' },
              incident_id: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['incident_id', 'note'],
          },
        ],
      },
    },
    required: ['request'],
  };

  type Node = { type: string; description: string; enum?: unknown[]; properties: Record<string, Node>; required: string[] };
  const request = () => (normaliseToolParameters(manageIncidents).properties as Record<string, Node>).request;

  it('keeps the fields of every variant, not just the first', () => {
    expect(Object.keys(request().properties)).toEqual(['action', 'incident', 'manage_request', 'incident_id', 'note']);
    expect(request().properties.manage_request.properties.incident_ids.type).toBe('array');
  });

  it('turns the discriminator into a required enum of every value', () => {
    expect(request().properties.action.enum).toEqual(['create', 'update', 'add_note']);
    expect(request().required).toEqual(['action']);
  });

  it('says which fields each operation needs', () => {
    expect(request().description).toContain('action="update" needs manage_request');
    expect(request().description).toContain('action="add_note" needs incident_id, note');
  });

  it('leaves the optional [object, null] idiom alone', () => {
    const out = normaliseToolParameters({
      type: 'object',
      properties: {
        body: { anyOf: [{ type: 'object', properties: { details: { type: 'string' } }, required: ['details'] }, { type: 'null' }] },
      },
    });
    const body = (out.properties as Record<string, Node>).body;
    expect(Object.keys(body.properties)).toEqual(['details']);
    expect(body.required).toEqual(['details']);
  });
});
