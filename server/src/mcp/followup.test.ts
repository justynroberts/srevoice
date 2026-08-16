import { describe, expect, it, vi } from 'vitest';
import { incidentIdFromWorkflowArgs, scheduleRemediationFollowUp, startsRemediation } from './followup.js';
import { PendingCalls } from './pending.js';
import type { McpPool } from './pool.js';

// The shape PagerDuty's MCP server actually asks for.
const ARGS = {
  workflow_id: 'PWF123',
  instance_request: {
    incident_workflow_instance: {
      id: null,
      incident: { id: 'PINC456', summary: 'booking-service pod CrashLoopBackOff' },
    },
  },
};

describe('finding the incident a workflow ran against', () => {
  it('digs the id out of the nested request', () => {
    expect(incidentIdFromWorkflowArgs(ARGS)).toBe('PINC456');
  });

  it('does not mistake the workflow id for the incident id', () => {
    // Both are called "id" at different depths; picking the wrong one would
    // check the wrong thing and report confidently about it.
    expect(incidentIdFromWorkflowArgs(ARGS)).not.toBe('PWF123');
  });

  it('accepts a flat incident_id too', () => {
    expect(incidentIdFromWorkflowArgs({ incident_id: 'PABC' })).toBe('PABC');
  });

  it('returns nothing when there is no incident to check', () => {
    expect(incidentIdFromWorkflowArgs({ workflow_id: 'PWF123' })).toBeUndefined();
  });
});

describe('which tools start a remediation', () => {
  it('recognises a workflow start on any server', () => {
    expect(startsRemediation('mcp2__start_incident_workflow')).toBe(true);
  });

  it('ignores everything else, including listing and reading', () => {
    expect(startsRemediation('mcp2__list_incident_workflows')).toBe(false);
    expect(startsRemediation('mcp2__get_incident')).toBe(false);
    expect(startsRemediation('rundeck__api_call')).toBe(false);
  });
});

describe('the check itself', () => {
  const poolWith = (incident: Record<string, unknown>, notes: unknown[]): McpPool =>
    ({
      call: vi.fn(async (name: string) =>
        name.endsWith('get_incident')
          ? { content: [{ type: 'text', text: JSON.stringify(incident) }] }
          : { content: [{ type: 'text', text: JSON.stringify(notes) }] },
      ),
    }) as unknown as McpPool;

  it('reports a resolved incident as the remediation having worked', async () => {
    const pending = new PendingCalls();
    scheduleRemediationFollowUp(
      poolWith({ status: 'resolved', title: 'booking-service crash', incident_number: 10725 }, []),
      pending,
      'mcp2__start_incident_workflow',
      ARGS,
      0,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(pending.outstanding()).toHaveLength(0);

    const [call] = pending.collectSettled();
    expect(call.result?.speech).toMatch(/remediation worked/i);
    expect(call.result?.speech).toMatch(/10725/);
  });

  it('says plainly when the incident is still open', async () => {
    const pending = new PendingCalls();
    scheduleRemediationFollowUp(
      poolWith({ status: 'triggered', title: 'booking-service crash' }, []),
      pending,
      'mcp2__start_incident_workflow',
      ARGS,
      0,
    );
    await new Promise((r) => setTimeout(r, 20));

    const [call] = pending.collectSettled();
    expect(call.result?.speech).toMatch(/still triggered/i);
    expect(call.result?.speech).toMatch(/no new notes/i);
  });

  it('schedules nothing when the incident cannot be identified', async () => {
    const pending = new PendingCalls();
    scheduleRemediationFollowUp(poolWith({}, []), pending, 'mcp2__start_incident_workflow', { workflow_id: 'x' }, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(pending.collectSettled()).toHaveLength(0);
    expect(pending.outstanding()).toHaveLength(0);
  });

  it('schedules nothing for a tool that only lists workflows', async () => {
    const pending = new PendingCalls();
    scheduleRemediationFollowUp(poolWith({}, []), pending, 'mcp2__list_incident_workflows', ARGS, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(pending.outstanding()).toHaveLength(0);
  });
});
