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
  const?: unknown;
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

/**
 * A union of two or more object shapes — `{oneOf: [{action: "create", incident},
 * {action: "update", manage_request}, …]}` — is how MCP servers spell a tool
 * with several operations behind one parameter.
 *
 * ElevenLabs takes a single object schema, and keeping only the first variant
 * (as for an optional `[object, null]`) hides every other operation: the agent
 * cannot send `manage_request` because, as far as it knows, there is no such
 * field. Asked to update an incident it sends `{action: "update"}` alone, and
 * the server rejects it.
 *
 * So the variants are merged instead: every field from every variant, the
 * discriminator's values combined into one enum, and a line in the description
 * saying which fields each value needs.
 */
function objectVariants(node: JsonSchemaLike): JsonSchemaLike[] {
  if (node.properties && typeof node.properties === 'object') return [];
  const found: JsonSchemaLike[] = [];
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!branch || typeof branch !== 'object') continue;
      const candidate = branch as JsonSchemaLike;
      const isObject = candidate.type === 'object' || candidate.type === undefined;
      if (isObject && candidate.properties && typeof candidate.properties === 'object') found.push(candidate);
    }
  }
  return found.length >= 2 ? found : [];
}

/** The first union branch that carries an object's properties. */
function objectBranch(node: JsonSchemaLike): JsonSchemaLike | undefined {
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (branch && typeof branch === 'object') {
        const candidate = branch as JsonSchemaLike;
        if (candidate.type === 'object' && candidate.properties !== undefined) return candidate;
      }
    }
  }
  return undefined;
}

/** The single value a node pins itself to, if any — `const`, or a one-value enum. */
function constOf(input: unknown): string | number | boolean | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const node = input as JsonSchemaLike;
  const value = node.const !== undefined ? node.const : Array.isArray(node.enum) && node.enum.length === 1 ? node.enum[0] : undefined;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
}

function requiredOf(node: JsonSchemaLike): string[] {
  return Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === 'string') : [];
}

interface MergedVariants {
  properties: Record<string, unknown>;
  required: string[];
  guide?: string;
}

function mergeVariants(variants: JsonSchemaLike[]): MergedVariants {
  const props = variants.map((v) => v.properties as Record<string, unknown>);

  // The field every variant pins to a distinct constant — usually `action`.
  const discriminator = Object.keys(props[0]).find((key) => {
    const values = props.map((p) => constOf(p[key]));
    return values.every((v) => v !== undefined) && new Set(values).size === values.length;
  });

  const properties: Record<string, unknown> = {};
  if (discriminator) {
    const values = props.map((p) => constOf(p[discriminator]) as string | number | boolean);
    const first = props[0][discriminator] as JsonSchemaLike;
    properties[discriminator] = {
      type: typeof values[0] === 'number' ? 'number' : typeof values[0] === 'boolean' ? 'boolean' : 'string',
      description:
        typeof first.description === 'string' && first.description.trim()
          ? first.description
          : `Which operation to perform: ${values.join(', ')}.`,
      enum: values,
    };
  }
  for (const p of props) {
    for (const [key, value] of Object.entries(p)) {
      if (key !== discriminator && !(key in properties)) properties[key] = value;
    }
  }

  // Only what every variant needs can be required of all of them.
  const required = requiredOf(variants[0]).filter((r) => variants.every((v) => requiredOf(v).includes(r)));
  if (discriminator && !required.includes(discriminator)) required.unshift(discriminator);

  const guide = discriminator
    ? variants
        .map((v) => {
          const needs = requiredOf(v).filter((r) => r !== discriminator);
          return `${discriminator}="${String(constOf((v.properties as Record<string, unknown>)[discriminator]))}"${needs.length ? ` needs ${needs.join(', ')}` : ''}`;
        })
        .join('; ')
    : undefined;

  return { properties, required, guide };
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
  // A `const` is a one-value enum, and says so far more plainly to the agent.
  const pinned = constOf(node);
  if (pinned !== undefined && !Array.isArray(node.enum)) out.enum = [pinned];
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
    const variants = objectVariants(node);
    const merged = variants.length ? mergeVariants(variants) : undefined;
    // `properties` can also sit inside an anyOf branch, same as `items`.
    const props = (merged?.properties ?? node.properties ?? unwrapBranch(node, 'object', 'properties')) as
      | Record<string, unknown>
      | undefined;
    const properties: Record<string, unknown> = {};
    if (props && typeof props === 'object') {
      for (const [key, value] of Object.entries(props)) {
        properties[key] = normaliseNode(value, depth + 1, key);
      }
    }
    out.properties = properties;
    // An optional object (`[object, null]`) keeps its `required` in the branch,
    // next to its properties; reading only the wrapper would drop it.
    const branch = !merged && !node.properties ? objectBranch(node) : undefined;
    out.required = (merged ? merged.required : requiredOf(branch ?? node)).filter((r) => r in properties);
    if (merged?.guide) {
      // The guide is what makes the merged shape usable, so it is the original
      // description that gives way to fit the budget, never the guide.
      const guide = ` Send only the fields for the chosen operation: ${merged.guide}.`;
      out.description = `${(out.description as string).slice(0, Math.max(0, MAX_DESCRIPTION - guide.length))}${guide}`.trim();
    }
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

/* ------------------------------------------------------------------------ */
/* The way back: arguments from ElevenLabs into the MCP server's real shape  */
/* ------------------------------------------------------------------------ */

const UNION_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;

function branchesOf(node: JsonSchemaLike): JsonSchemaLike[] {
  return UNION_KEYS.flatMap((key) => {
    const branches = node[key];
    return Array.isArray(branches) ? branches.filter((b): b is JsonSchemaLike => !!b && typeof b === 'object') : [];
  });
}

/** Every type a node can take, looking through unions. */
function typesOf(node: JsonSchemaLike, depth = 0): Set<string> {
  const types = new Set<string>();
  if (typeof node.type === 'string') types.add(node.type);
  if (Array.isArray(node.type)) node.type.forEach((t) => typeof t === 'string' && types.add(t));
  if (node.properties) types.add('object');
  if (node.items) types.add('array');
  if (typeof node.const === 'string' || (Array.isArray(node.enum) && node.enum.some((v) => typeof v === 'string'))) {
    types.add('string');
  }
  if (depth < 8) for (const branch of branchesOf(node)) typesOf(branch, depth + 1).forEach((t) => types.add(t));
  return types;
}

/**
 * The properties to check an object value against. For a union of variants,
 * the one whose discriminator matches the value comes first, so a key that
 * means different things in different operations is read the right way.
 */
function propertiesFor(node: JsonSchemaLike, value: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const add = (props: unknown) => {
    if (!props || typeof props !== 'object') return;
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) if (!(k in merged)) merged[k] = v;
  };
  add(node.properties);
  const branches = branchesOf(node).filter((b) => b.properties && typeof b.properties === 'object');
  const matches = (b: JsonSchemaLike) =>
    Object.entries(b.properties as Record<string, unknown>).some(([k, s]) => {
      const pinned = constOf(s);
      return pinned !== undefined && value[k] === pinned;
    });
  branches.filter(matches).forEach((b) => add(b.properties));
  branches.forEach((b) => add(b.properties));
  return merged;
}

function itemsFor(node: JsonSchemaLike): unknown {
  return node.items ?? branchesOf(node).find((b) => b.items !== undefined)?.items;
}

/**
 * Undoes what normalisation had to do on the way out. Past `MAX_DEPTH`, an
 * object or list was presented to the agent as "pass as a JSON string", so it
 * sends `'{"id": "Q1W…", "type": "incident_reference"}'` — and the MCP server,
 * which never agreed to strings there, rejects it ("Input should be a valid
 * dictionary"). Wherever the real schema wants a container and cannot take a
 * string, a JSON string is parsed back into one.
 *
 * Deliberately conservative: a field whose schema accepts a string (a request
 * body that may be YAML) is never touched, and anything that does not parse
 * is passed through for the server to explain.
 */
export function reviveArguments(value: unknown, schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 32) return value;
  const node = schema as JsonSchemaLike;

  if (typeof value === 'string') {
    const types = typesOf(node);
    if (types.has('string') || !(types.has('object') || types.has('array'))) return value;
    const text = value.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return value;
    try {
      value = JSON.parse(text);
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) {
    const items = itemsFor(node);
    return value.map((v) => reviveArguments(v, items, depth + 1));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const props = propertiesFor(node, record);
    return Object.fromEntries(
      Object.entries(record).map(([k, v]) => [k, k in props ? reviveArguments(v, props[k], depth + 1) : v]),
    );
  }
  return value;
}
