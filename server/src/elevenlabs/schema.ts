/**
 * MCP servers emit full JSON Schema; the ElevenLabs tool-parameter parser
 * accepts a conservative subset. Anything it cannot model is flattened rather
 * than dropped, so the agent still knows the field exists.
 */

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const MAX_DEPTH = 4;

interface JsonSchemaLike {
  type?: unknown;
  description?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  enum?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
  default?: unknown;
}

function firstConcreteType(node: JsonSchemaLike): string | undefined {
  if (typeof node.type === 'string' && ALLOWED_TYPES.has(node.type)) return node.type;

  // `type: ["string", "null"]` is common — take the first non-null member.
  if (Array.isArray(node.type)) {
    const found = node.type.find((t) => typeof t === 'string' && t !== 'null' && ALLOWED_TYPES.has(t));
    if (typeof found === 'string') return found;
  }

  // Unions: adopt the first branch that resolves to something concrete.
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (branch && typeof branch === 'object') {
          const t = firstConcreteType(branch as JsonSchemaLike);
          if (t) return t;
        }
      }
    }
  }
  return undefined;
}

/**
 * `{"anyOf": [{"type": "array", "items": {...}}, {"type": "null"}]}` is how
 * MCP servers spell an optional list. The type resolves through `anyOf`, but
 * `items` stays behind in the branch — recover it so the array is not left
 * item-less.
 */
function unwrapArrayBranch(node: JsonSchemaLike): unknown {
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (branch && typeof branch === 'object') {
        const candidate = branch as JsonSchemaLike;
        if (candidate.type === 'array' && candidate.items !== undefined) return candidate.items;
      }
    }
  }
  return undefined;
}

function normaliseNode(input: unknown, depth: number): Record<string, unknown> {
  if (!input || typeof input !== 'object') return { type: 'string' };
  const node = input as JsonSchemaLike;

  const type = firstConcreteType(node) ?? 'string';
  const out: Record<string, unknown> = { type };

  if (typeof node.description === 'string' && node.description.trim()) {
    out.description = node.description.trim().slice(0, 500);
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    out.enum = node.enum.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 50);
    if ((out.enum as unknown[]).length === 0) delete out.enum;
  }

  // Past the depth limit, describe the shape in prose instead of nesting
  // further — deep schemas are where the parser gets brittle.
  if (depth >= MAX_DEPTH) {
    if (type === 'object' || type === 'array') {
      out.type = 'string';
      out.description = `${out.description ? `${out.description} ` : ''}(Pass as a JSON string.)`;
    }
    return out;
  }

  if (type === 'object') {
    const props = node.properties;
    const properties: Record<string, unknown> = {};
    if (props && typeof props === 'object') {
      for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
        properties[key] = normaliseNode(value, depth + 1);
      }
    }
    out.properties = properties;
    out.required = Array.isArray(node.required)
      ? node.required.filter((r): r is string => typeof r === 'string' && r in properties)
      : [];
  }

  if (type === 'array') {
    // ElevenLabs rejects an array whose `items` lacks a description:
    // "Must set one of: description, dynamic_variable, is_system_provided,
    // constant_value, or is_omitted" (422). MCP servers routinely omit both
    // the items schema and its description — most often when the array is one
    // branch of an `anyOf`, where `items` sits inside the branch rather than
    // on the node — so synthesise whatever is missing rather than losing the
    // whole tool.
    const items = normaliseNode(node.items ?? unwrapArrayBranch(node), depth + 1);
    if (typeof items.description !== 'string' || !items.description) {
      items.description = out.description
        ? `An entry in: ${String(out.description)}`
        : 'A single item in the list.';
    }
    out.items = items;
  }

  return out;
}

/** Always returns an object schema — ElevenLabs rejects a bare scalar root. */
export function normaliseToolParameters(inputSchema: unknown): Record<string, unknown> {
  const normalised = normaliseNode(inputSchema, 0);
  if (normalised.type !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }
  if (!normalised.properties) normalised.properties = {};
  if (!normalised.required) normalised.required = [];
  return normalised;
}
