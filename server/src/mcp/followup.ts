import { logger } from '../logger.js';
import type { McpPool } from './pool.js';
import type { PendingCalls } from './pending.js';
import { renderToolResult, type RenderedResult } from './render.js';

/**
 * "Started the rollback" is not the same as "the rollback worked", and the
 * recorded sessions all stop at the first one. A workflow that could remediate
 * an incident is worth going back to: the engineer wants to know whether the
 * status moved and what the workflow wrote in the notes, and asking them to
 * remember to ask is how a demo ends with an open incident nobody rechecked.
 *
 * The check rides the existing late-result path — the same registry that
 * carries a tool call which outran its turn — so it reaches the agent as a
 * contextual update she can mention in her own words, without being asked.
 */
const FOLLOW_UP_DELAY_MS = 90_000;

/** Long enough for the workflow to have done something, short enough to matter. */
export const followUpDelayMs = FOLLOW_UP_DELAY_MS;

function firstString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = firstString(v, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = rec[key];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
  }
  for (const v of Object.values(rec)) {
    const found = firstString(v, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * The incident a workflow was started against. It is nested a few levels down
 * inside `instance_request.incident_workflow_instance.incident.id`, and the
 * exact nesting is the MCP server's business rather than ours, so the id is
 * found by shape.
 */
export function incidentIdFromWorkflowArgs(args: Record<string, unknown>): string | undefined {
  const instance = args.instance_request ?? args;
  const rec = instance as Record<string, unknown>;
  const incident = firstString(rec, ['incident_id']);
  if (incident) return incident;

  // `incident: { id }` — take the id belonging to an object called incident,
  // not the workflow's own id.
  const found = ((): string | undefined => {
    const walk = (v: unknown, depth = 0): string | undefined => {
      if (depth > 6 || !v || typeof v !== 'object') return undefined;
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1)).find(Boolean);
      const r = v as Record<string, unknown>;
      const inc = r.incident;
      if (inc && typeof inc === 'object' && typeof (inc as Record<string, unknown>).id === 'string') {
        return (inc as Record<string, unknown>).id as string;
      }
      for (const child of Object.values(r)) {
        const hit = walk(child, depth + 1);
        if (hit) return hit;
      }
      return undefined;
    };
    return walk(rec);
  })();
  return found;
}

/** Tools that start something capable of changing an incident. */
export function startsRemediation(tool: string): boolean {
  return /__start_incident_workflow$/.test(tool);
}

function summarise(incident: unknown, notes: unknown, startedAt: number): RenderedResult {
  const inc = (incident ?? {}) as Record<string, unknown>;
  const status = typeof inc.status === 'string' ? inc.status : 'unknown';
  const title = typeof inc.title === 'string' ? inc.title : 'the incident';
  const number = inc.incident_number;

  const all = Array.isArray(notes) ? notes : [];
  const since = all.filter((n) => {
    const created = (n as Record<string, unknown>)?.created_at;
    return typeof created === 'string' && Date.parse(created) >= startedAt - 5_000;
  });
  const newest = since.slice(-3).map((n) => String((n as Record<string, unknown>).content ?? '').trim());

  const noteLine = since.length
    ? `${since.length} new note${since.length === 1 ? '' : 's'} since it started${newest.length ? `: ${newest.join(' | ')}` : ''}`
    : 'no new notes yet';

  const resolved = status === 'resolved';
  const lead = resolved
    ? `The remediation worked — ${title}${number ? ` (${number})` : ''} is resolved.`
    : `${title}${number ? ` (${number})` : ''} is still ${status} after the workflow ran.`;

  return {
    speech: `${lead} ${noteLine}.`,
    display: { incident: inc, newNotes: since, checkedAt: new Date().toISOString() },
    isError: false,
    truncated: false,
  };
}

/**
 * Schedules the after-the-fact check. Registered with the pending registry so
 * the browser's existing poll delivers it, meaning nothing new is needed on the
 * client and an interrupted conversation still gets the answer.
 */
export function scheduleRemediationFollowUp(
  pool: McpPool,
  pending: PendingCalls,
  tool: string,
  args: Record<string, unknown>,
  delayMs = FOLLOW_UP_DELAY_MS,
): void {
  if (!startsRemediation(tool)) return;

  const incidentId = incidentIdFromWorkflowArgs(args);
  if (!incidentId) {
    logger.warn({ tool }, 'Started a remediation workflow but could not tell which incident');
    return;
  }

  const serverId = tool.split('__')[0];
  const callId = `followup-${incidentId}-${Date.now()}`;

  const work = (async (): Promise<RenderedResult> => {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    // Failures here are reported rather than thrown: a follow-up that cannot
    // read the incident should say so, not vanish.
    const read = async (name: string) => {
      try {
        return renderToolResult(await pool.call(`${serverId}__${name}`, { incident_id: incidentId }));
      } catch (err) {
        logger.warn({ tool: name, err: (err as Error).message }, 'Follow-up read failed');
        return null;
      }
    };

    const [incident, notes] = await Promise.all([read('get_incident'), read('list_incident_notes')]);
    if (!incident) {
      return {
        speech: `I could not re-check incident ${incidentId} after the workflow ran — worth a look.`,
        display: { incidentId, error: 'follow-up read failed' },
        isError: false,
        truncated: false,
      };
    }

    const unwrap = (r: RenderedResult | null): unknown => {
      const d = r?.display as Record<string, unknown> | undefined;
      return d?.incident ?? d?.notes ?? d?.body ?? d?.data ?? d;
    };
    return summarise(unwrap(incident), unwrap(notes), startedAt);
  })();

  pending.track(callId, `${serverId}__incident_followup`, { incident_id: incidentId }, work);
  logger.info({ incidentId, delayMs }, 'Scheduled a post-remediation check');
}
