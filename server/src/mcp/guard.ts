import type { RenderedResult } from './render.js';
import type { AuthoredJobStore } from '../store/authored.js';
import { unqualify } from './names.js';

/**
 * The agent may start a workflow, because a workflow is a named procedure a
 * human wrote and approved in advance. It may not run an automation job it
 * wrote itself: composing a job means composing arbitrary shell commands, and
 * running one executes them on real infrastructure. Doing both in one breath is
 * unreviewed code reaching production because someone asked out loud.
 *
 * Enforced here rather than in the prompt. The agent has overridden written
 * instructions before — including a house rule saying workflows were
 * pre-approved — so a rule that matters cannot live only in text it is free to
 * reinterpret.
 */

/** `job/<id>/run`, `job/<id>/executions`, with or without an `/api/NN` prefix. */
const RUN_ENDPOINT = /(?:^|\/)job\/([^/?#]+)\/(?:run|executions)\b/i;

/** Ad-hoc execution: no job at all, just commands or a script to run. */
const ADHOC_ENDPOINT = /(?:^|\/)project\/[^/]+\/run\/(?:command|script|url)\b/i;

function endpointOf(args: Record<string, unknown>): string {
  return typeof args.endpoint === 'string' ? args.endpoint : '';
}

function methodOf(args: Record<string, unknown>): string {
  return (typeof args.method === 'string' ? args.method : 'GET').toUpperCase();
}

function refusal(speech: string, detail: Record<string, unknown>): RenderedResult {
  return {
    speech,
    display: { refused: true, ...detail },
    // Not an error: nothing failed. The agent should explain this calmly rather
    // than report a broken tool.
    isError: false,
    truncated: false,
  };
}

/**
 * Called before a tool runs. Returns a result to send back instead of calling,
 * or null to let the call proceed.
 */
export async function guardToolCall(
  authored: AuthoredJobStore,
  tool: string,
  args: Record<string, unknown>,
): Promise<RenderedResult | null> {
  const parsed = unqualify(tool);
  // Scoped to the generic API tool, which is the only way to reach an execution
  // endpoint. Workflow tools are deliberately untouched.
  if (!parsed || !parsed.toolName.endsWith('api_call')) return null;

  const endpoint = endpointOf(args);
  if (!endpoint) return null;
  if (methodOf(args) === 'GET') return null;

  const run = RUN_ENDPOINT.exec(endpoint);
  if (run) {
    const jobId = run[1];
    const job = await authored.find(jobId);
    if (!job) return null; // Someone else wrote it; not our rule to apply.

    const where = job.project ? ` in the ${job.project} project` : '';
    return refusal(
      `I wrote that job, so I will not run it. ${job.name || 'It'} is saved${where} — someone needs to read it and start it themselves. ` +
        `Workflows are different: those are pre-approved and I can run them for you.`,
      { jobId, job: job.name, project: job.project, authoredAt: job.createdAt, rule: 'agent-authored-job' },
    );
  }

  if (ADHOC_ENDPOINT.test(endpoint)) {
    return refusal(
      'I will not run ad-hoc commands. That is the same as writing a job and running it in one step, with nobody reading it first. ' +
        'I can write it up as a job for someone to review, or run a workflow if one covers this.',
      { endpoint, rule: 'adhoc-execution' },
    );
  }

  return null;
}

/** Job entries in a Rundeck import response, whatever depth they arrive at. */
function collectImported(value: unknown, depth = 0): Array<{ jobId: string; name?: string; project?: string }> {
  if (depth > 6 || !value || typeof value !== 'object') return [];

  if (Array.isArray(value)) return value.flatMap((v) => collectImported(v, depth + 1));

  const rec = value as Record<string, unknown>;
  // A job entry proper: an id alongside a name is what the import result and
  // the job-list endpoint both return.
  if (typeof rec.id === 'string' && (typeof rec.name === 'string' || typeof rec.href === 'string')) {
    return [
      {
        jobId: rec.id,
        name: typeof rec.name === 'string' ? rec.name : undefined,
        project: typeof rec.project === 'string' ? rec.project : undefined,
      },
    ];
  }
  return Object.values(rec).flatMap((v) => collectImported(v, depth + 1));
}

/**
 * Called after a tool runs. Records any job the agent just created, so a later
 * session refuses to run it.
 */
export async function recordAuthorship(
  authored: AuthoredJobStore,
  tool: string,
  args: Record<string, unknown>,
  result: RenderedResult,
): Promise<void> {
  const parsed = unqualify(tool);
  if (!parsed || !parsed.toolName.endsWith('api_call')) return;
  if (!/(?:^|\/)project\/[^/]+\/jobs\/import\b/i.test(endpointOf(args))) return;
  if (result.isError) return;

  const payload = typeof result.display === 'string' ? safeJson(result.display) : result.display;
  const body = (payload as { body?: unknown; data?: unknown } | null)?.body ??
    (payload as { data?: unknown } | null)?.data ??
    payload;

  // Only the jobs Rundeck reports as accepted. A failed entry was never created
  // and recording it would refuse to run a job that someone else later writes
  // under the same id.
  const succeeded = (body as { succeeded?: unknown } | null)?.succeeded;
  const jobs = collectImported(succeeded ?? body);
  await authored.record(jobs);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
