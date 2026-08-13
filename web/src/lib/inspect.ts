/**
 * MCP tool results arrive as arbitrary JSON. Rather than hand-writing a
 * renderer per PagerDuty tool — which would break the moment the schema shifts
 * or a second MCP server is added — the shape is sniffed at runtime and
 * rendered with the most specific view that fits.
 */

export interface IncidentLike {
  id: string;
  number?: number;
  title: string;
  status?: string;
  urgency?: string;
  priority?: string;
  service?: string;
  assignee?: string;
  createdAt?: string;
  url?: string;
}

export type Shape =
  | { kind: 'empty' }
  | { kind: 'titled'; title: string; note?: string; inner: unknown }
  | { kind: 'lines'; lines: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'incidents'; incidents: IncidentLike[]; total: number }
  | { kind: 'table'; rows: Record<string, unknown>[]; columns: string[] }
  | { kind: 'object'; entries: [string, unknown][] }
  | { kind: 'http'; status: number; ok: boolean; summary: string; body: unknown; headers: [string, unknown][] }
  | { kind: 'json'; value: unknown };

/**
 * What a status code means to someone who does not read status codes. The
 * point is a person can tell at a glance whether the thing they asked for
 * happened.
 */
const STATUS_TEXT: Record<number, string> = {
  200: 'Worked',
  201: 'Created',
  202: 'Accepted — running now',
  204: 'Done, nothing to show',
  400: "Rundeck did not understand the request",
  401: 'Not signed in — the token was rejected',
  403: 'Not allowed — the token lacks permission',
  404: 'Not found',
  405: 'That endpoint does not accept this method',
  409: 'Conflicted with something already there',
  415: 'Wrong content type for this endpoint',
  422: 'Rejected as invalid',
  429: 'Rate limited — too many requests',
  500: 'The server errored',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'The server timed out',
};

function statusSummary(status: number): string {
  const known = STATUS_TEXT[status];
  if (known) return known;
  if (status < 300) return 'Worked';
  if (status < 400) return 'Redirected';
  if (status < 500) return 'Request rejected';
  return 'Server error';
}

/**
 * Tool output frequently arrives as a JSON document inside a string. Left as a
 * string it renders as a wall of escaped punctuation, so parse it and let the
 * normal shape detection do its job.
 */
function parseIfJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * A raw HTTP envelope — `{ status, headers, body }` — as returned by generic
 * API-call tools. Nobody wants to read twenty response headers to find out a
 * request returned 200.
 */
function asHttpEnvelope(rec: Record<string, unknown>): Shape | null {
  const status = rec.status;
  if (typeof status !== 'number' || status < 100 || status > 599) return null;
  if (!('headers' in rec) && !('body' in rec) && !('data' in rec)) return null;

  const headers = asRecord(rec.headers);
  const body = 'body' in rec ? rec.body : rec.data;

  return {
    kind: 'http',
    status,
    ok: status < 400,
    summary: statusSummary(status),
    body: typeof body === 'string' ? (parseIfJson(body) ?? body) : body,
    headers: headers ? Object.entries(headers) : [],
  };
}

const INCIDENT_KEYS = ['incident_number', 'incidents', 'incident_key'];

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

/** Pulls `summary`/`name` out of PagerDuty's nested reference objects. */
function summaryOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const rec = asRecord(v);
  if (!rec) return undefined;
  return str(rec.summary) ?? str(rec.name) ?? str(rec.description);
}

function looksLikeIncident(rec: Record<string, unknown>): boolean {
  if ('incident_number' in rec) return true;
  const hasTitle = 'title' in rec || 'summary' in rec;
  const hasStatus = 'status' in rec;
  const hasIncidentish = 'urgency' in rec || 'service' in rec || 'escalation_policy' in rec;
  return hasTitle && hasStatus && hasIncidentish;
}

function toIncident(rec: Record<string, unknown>, index: number): IncidentLike {
  const assignments = rec.assignments;
  let assignee: string | undefined;
  if (Array.isArray(assignments) && assignments.length > 0) {
    const first = asRecord(assignments[0]);
    assignee = summaryOf(first?.assignee);
    if (assignments.length > 1) assignee = `${assignee ?? 'someone'} +${assignments.length - 1}`;
  }

  return {
    id: str(rec.id) ?? str(rec.incident_number) ?? `row-${index}`,
    number: typeof rec.incident_number === 'number' ? rec.incident_number : undefined,
    title: str(rec.title) ?? summaryOf(rec.summary) ?? 'Untitled incident',
    status: str(rec.status),
    urgency: str(rec.urgency),
    priority: summaryOf(rec.priority),
    service: summaryOf(rec.service),
    assignee,
    createdAt: str(rec.created_at) ?? str(rec.createdAt),
    url: str(rec.html_url) ?? str(rec.url),
  };
}

/**
 * Finds the meaningful array inside a wrapper object. MCP servers commonly
 * return `{ incidents: [...] }`, `{ response: { data: [...] } }`, or the bare
 * array, and the caller should not have to care which.
 */
function findCollection(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (depth > 3) return null;
  const rec = asRecord(value);
  if (!rec) return null;

  const preferred = ['incidents', 'items', 'data', 'results', 'records', 'response', 'oncalls', 'services', 'users'];
  for (const key of preferred) {
    if (key in rec) {
      const found = findCollection(rec[key], depth + 1);
      if (found) return found;
    }
  }
  // Single-key wrapper: unwrap it rather than rendering a pointless nest.
  const keys = Object.keys(rec);
  if (keys.length === 1) return findCollection(rec[keys[0]], depth + 1);
  return null;
}

export function classify(value: unknown): Shape {
  if (value === null || value === undefined || value === '') return { kind: 'empty' };

  // A screen__show payload — the agent's own filtered view. Keep the heading
  // and render the rows with whatever renderer their shape deserves.
  const rec0 = asRecord(value);
  if (rec0 && typeof rec0.title === 'string' && Array.isArray(rec0.items)) {
    return {
      kind: 'titled',
      title: rec0.title,
      note: typeof rec0.note === 'string' ? rec0.note : undefined,
      inner: rec0.items,
    };
  }

  if (typeof value === 'string') {
    // A JSON document that merely arrived as a string is still data.
    const parsed = parseIfJson(value);
    if (parsed !== undefined) return classify(parsed);
    return { kind: 'text', text: value };
  }

  if (rec0) {
    const http = asHttpEnvelope(rec0);
    if (http) return http;
  }

  const collection = findCollection(value);
  if (collection) {
    if (collection.length === 0) return { kind: 'empty' };

    // A list of strings is prose, not data. Rendering it as a JSON array —
    // quoted, escaped, bracketed — is the single least readable option.
    if (collection.every((c) => typeof c === 'string')) {
      return { kind: 'lines', lines: collection as string[] };
    }

    const records = collection.filter((r): r is Record<string, unknown> => asRecord(r) !== null);

    if (records.length === collection.length && records.length > 0) {
      const incidentCount = records.filter(looksLikeIncident).length;
      // A clear majority keeps a mixed payload from falling back to raw JSON.
      if (incidentCount / records.length >= 0.6) {
        return {
          kind: 'incidents',
          incidents: records.map(toIncident),
          total: records.length,
        };
      }

      const columns = pickColumns(records);
      if (columns.length > 0) return { kind: 'table', rows: records, columns };
    }
    return { kind: 'json', value: collection };
  }

  const rec = asRecord(value);
  if (rec) {
    if (looksLikeIncident(rec)) {
      return { kind: 'incidents', incidents: [toIncident(rec, 0)], total: 1 };
    }
    const entries = Object.entries(rec);
    if (entries.length > 0 && entries.length <= 24) return { kind: 'object', entries };
  }

  const hasIncidentHint = JSON.stringify(value).length < 200_000 &&
    INCIDENT_KEYS.some((k) => JSON.stringify(value).includes(k));
  if (hasIncidentHint) return { kind: 'json', value };

  return { kind: 'json', value };
}

/** Prefers identifying columns, then fills up to six with whatever is scalar. */
function pickColumns(rows: Record<string, unknown>[]): string[] {
  const sample = rows.slice(0, 20);
  const counts = new Map<string, number>();

  for (const row of sample) {
    for (const [key, val] of Object.entries(row)) {
      const scalar = val === null || ['string', 'number', 'boolean'].includes(typeof val);
      const summarisable = summaryOf(val) !== undefined;
      if (scalar || summarisable) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const threshold = sample.length * 0.5;
  const viable = [...counts.entries()].filter(([, n]) => n >= threshold).map(([k]) => k);

  const priority = ['id', 'name', 'title', 'summary', 'status', 'type', 'label', 'description'];
  const ordered = [
    ...priority.filter((p) => viable.includes(p)),
    ...viable.filter((v) => !priority.includes(v)),
  ];
  return ordered.slice(0, 6);
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return summaryOf(value) ?? JSON.stringify(value).slice(0, 80);
  return String(value);
}
