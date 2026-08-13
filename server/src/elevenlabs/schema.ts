/**
 * MCP servers emit full JSON Schema; the ElevenLabs tool-parameter parser
 * accepts a conservative subset. Anything it cannot model is flattened rather
 * than dropped, so the agent still knows the field exists.
 */

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const MAX_DEPTH = 4;
const MAX_DESCRIPTION = 500;

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

/** Every concrete type a union offers, in declaration order, deduplicated. */
function unionTypes(node: JsonSchemaLike): string[] {
  const found: string[] = [];
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (branch && typeof branch === 'object') {
        const t = firstConcreteType(branch as JsonSchemaLike);
        if (t && !found.includes(t)) found.push(t);
      }
    }
  }
  return found;
}

/**
 * True when a union offers a string *as well as* a container. ElevenLabs takes
 * one type per parameter, so picking the container silently removes the ability
 * to send a string — and for a parameter like an HTTP request body, the string
 * branch is the only one that can carry a non-JSON payload such as YAML.
 *
 * A string can always carry the serialised form of the other branches, so it is
 * the branch that loses the least. Note this is deliberately not triggered by
 * the `[array, null]` / `[string, null]` optional idiom, which has only one
 * concrete type and must keep it.
 */
function prefersStringBranch(node: JsonSchemaLike): boolean {
  const types = unionTypes(node);
  return types.includes('string') && (types.includes('object') || types.includes('array'));
}

function firstConcreteType(node: JsonSchemaLike): string | undefined {
  if (typeof node.type === 'string' && ALLOWED_TYPES.has(node.type)) return node.type;

  // `type: ["string", "null"]` is common — take the first non-null member.
  if (Array.isArray(node.type)) {
    const found = node.type.find((t) => typeof t === 'string' && t !== 'null' && ALLOWED_TYPES.has(t));
    if (typeof found === 'string') return found;
  }

  if (prefersStringBranch(node)) return 'string';

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
 * `{"anyOf": [{"type": "array", "items": {...}}, {"type": "null"}]}` is how MCP
 * servers spell an optional value. The type resolves through `anyOf`, but the
 * shape — `items` for a list, `properties` for an object — stays behind in the
 * branch. Recover it so the node is not left empty.
 */
function unwrapBranch(
  node: JsonSchemaLike,
  wantType: 'array' | 'object',
  field: 'items' | 'properties',
): unknown {
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (branch && typeof branch === 'object') {
        const candidate = branch as JsonSchemaLike;
        if (candidate.type === wantType && candidate[field] !== undefined) return candidate[field];
      }
    }
  }
  return undefined;
}

/** `escalation_policy_id` → "Escalation policy id" — a usable last-resort description. */
function humanise(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * `name` is the property this node was reached through, used only to synthesise
 * a description when the schema omits one.
 */
function normaliseNode(input: unknown, depth: number, name = ''): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    return { type: 'string', description: describe(undefined, name) };
  }
  const node = input as JsonSchemaLike;

  const type = firstConcreteType(node) ?? 'string';
  const out: Record<string, unknown> = { type };

  // ElevenLabs requires a description on *every* node, at any nesting depth:
  // "Must set one of: description, dynamic_variable, is_system_provided,
  // constant_value, or is_omitted" (422). MCP servers commonly describe the
  // top-level parameters and leave nested ones bare, which would cost the
  // whole tool — so synthesise one from the property name.
  out.description = describe(node.description, name);
  // The agent sees only the flattened type, so say what the string has to hold.
  // Trimmed to keep the whole description inside the same budget `describe`
  // applies, rather than pushing past it by the length of the note.
  if (type === 'string' && prefersStringBranch(node)) {
    const note = ' (Send as a string — serialise JSON yourself, or pass raw text such as YAML verbatim.)';
    out.description = `${(out.description as string).slice(0, MAX_DESCRIPTION - note.length)}${note}`;
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
    // `properties` can also sit inside an anyOf branch, same as `items`.
    const props = (node.properties ?? unwrapBranch(node, 'object', 'properties')) as
      | Record<string, unknown>
      | undefined;
    const properties: Record<string, unknown> = {};
    if (props && typeof props === 'object') {
      for (const [key, value] of Object.entries(props)) {
        properties[key] = normaliseNode(value, depth + 1, key);
      }
    }
    out.properties = properties;
    out.required = Array.isArray(node.required)
      ? node.required.filter((r): r is string => typeof r === 'string' && r in properties)
      : [];
  }

  if (type === 'array') {
    // `items` is often left behind in an anyOf branch when a list is optional.
    const items = node.items ?? unwrapBranch(node, 'array', 'items');
    out.items = normaliseNode(items, depth + 1, name ? `${name} entry` : 'item');
  }

  return out;
}

function describe(existing: unknown, name: string): string {
  if (typeof existing === 'string' && existing.trim()) return existing.trim().slice(0, MAX_DESCRIPTION);
  const humanised = humanise(name);
  return humanised || 'No description provided.';
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
