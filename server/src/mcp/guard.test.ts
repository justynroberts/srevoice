import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthoredJobStore } from '../store/authored.js';
import { guardToolCall, recordAuthorship } from './guard.js';
import type { RenderedResult } from './render.js';

const MASTER_KEY = 'IGoAP0K5aH2Yy1qz8VbC3nJd7Lm4Rt6Xw9Ee0Uu5Iio=';
const JOB_ID = 'eedd47e8-0998-4815-bad1-3ab1fa25b4e5';

const importResult = (succeeded: unknown[]): RenderedResult => ({
  speech: '',
  display: { status: 200, headers: {}, body: { succeeded, failed: [] } },
  isError: false,
  truncated: false,
});

describe('agent-authored jobs may not be run by the agent', () => {
  let dir: string;
  let authored: AuthoredJobStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'srevoice-guard-'));
    authored = new AuthoredJobStore(dir, MASTER_KEY);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const importJob = () =>
    recordAuthorship(
      authored,
      'rundeck__api_call',
      { endpoint: 'project/Paige/jobs/import', method: 'POST' },
      importResult([{ id: JOB_ID, name: 'Redis Health Check', project: 'Paige' }]),
    );

  it('refuses to run a job it wrote', async () => {
    await importJob();
    const verdict = await guardToolCall(authored, 'rundeck__api_call', {
      endpoint: `job/${JOB_ID}/run`,
      method: 'POST',
    });

    expect(verdict).not.toBeNull();
    expect(verdict!.speech).toMatch(/I wrote that job/i);
    expect(verdict!.speech).toMatch(/Redis Health Check/);
    // Not an error — nothing failed, so she should explain rather than report a
    // broken tool.
    expect(verdict!.isError).toBe(false);
  });

  it('still refuses in a later session that never saw the job created', async () => {
    await importJob();
    // The whole point of persisting: a fresh process must reach the same verdict.
    const reopened = new AuthoredJobStore(dir, MASTER_KEY);
    const verdict = await guardToolCall(reopened, 'rundeck__api_call', {
      endpoint: `job/${JOB_ID}/executions`,
      method: 'POST',
    });
    expect(verdict).not.toBeNull();
  });

  it('lets a job somebody else wrote run', async () => {
    await importJob();
    const verdict = await guardToolCall(authored, 'rundeck__api_call', {
      endpoint: 'job/11111111-2222-3333-4444-555555555555/run',
      method: 'POST',
    });
    expect(verdict).toBeNull();
  });

  it('leaves workflows alone — those are pre-approved', async () => {
    await importJob();
    expect(await guardToolCall(authored, 'mcp2__start_incident_workflow', { incident_id: 'PABC' })).toBeNull();
    expect(await guardToolCall(authored, 'mcp1__sre_agent_tool', { prompt: 'run the rollback workflow' })).toBeNull();
  });

  it('still lets it read the job it wrote', async () => {
    await importJob();
    // Refusing to *run* must not turn into refusing to show someone the thing
    // they now have to review.
    expect(
      await guardToolCall(authored, 'rundeck__api_call', { endpoint: `job/${JOB_ID}`, method: 'GET' }),
    ).toBeNull();
    expect(
      await guardToolCall(authored, 'rundeck__api_call', {
        endpoint: `job/${JOB_ID}/executions`,
        method: 'GET',
      }),
    ).toBeNull();
  });

  it('refuses ad-hoc execution outright', async () => {
    // Writing a job and running it in one step, with nobody reading it.
    const verdict = await guardToolCall(authored, 'rundeck__api_call', {
      endpoint: 'project/Paige/run/command',
      method: 'POST',
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.speech).toMatch(/ad-hoc/i);
  });

  it('records nothing for an import that failed', async () => {
    await recordAuthorship(
      authored,
      'rundeck__api_call',
      { endpoint: 'project/Paige/jobs/import', method: 'POST' },
      { ...importResult([]), isError: true },
    );
    expect(await authored.all()).toEqual([]);
  });

  it('records only the jobs Rundeck accepted', async () => {
    await recordAuthorship(
      authored,
      'rundeck__api_call',
      { endpoint: 'project/Paige/jobs/import', method: 'POST' },
      {
        speech: '',
        display: {
          status: 200,
          body: {
            succeeded: [{ id: JOB_ID, name: 'Kept', project: 'Paige' }],
            failed: [{ id: 'never-created', name: 'Rejected' }],
          },
        },
        isError: false,
        truncated: false,
      },
    );

    const ids = (await authored.all()).map((j) => j.jobId);
    expect(ids).toEqual([JOB_ID]);
    // A rejected entry was never created; recording it would refuse to run a
    // job somebody else later writes under that id.
    expect(ids).not.toContain('never-created');
  });

  it('matches a run endpoint carrying an api version prefix', async () => {
    await importJob();
    const verdict = await guardToolCall(authored, 'rundeck__api_call', {
      endpoint: `/api/59/job/${JOB_ID}/run`,
      method: 'POST',
    });
    expect(verdict).not.toBeNull();
  });
});
