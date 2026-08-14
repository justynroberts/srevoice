import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from './prompt.js';
import type { CatalogueEntry } from '../mcp/pool.js';

const entry = (name: string, label = 'PagerDuty'): CatalogueEntry => ({
  qualifiedName: name,
  serverId: 'pd',
  serverLabel: label,
  remoteName: name,
  description: 'Does a thing. Extra detail that should be trimmed.',
  inputSchema: {},
});

describe('buildSystemPrompt', () => {
  it('appends operator instructions last so they take priority', () => {
    const out = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, [entry('pd__list')], 'Pronounce SRE as S.R.E.');
    expect(out).toContain('Pronounce SRE as S.R.E.');
    expect(out.indexOf('Pronounce SRE')).toBeGreaterThan(out.indexOf('Connected tools'));
    expect(out).toContain('House rules');
  });

  it('adds no section when there are no operator instructions', () => {
    expect(buildSystemPrompt('base', [entry('pd__list')])).not.toContain('House rules');
    expect(buildSystemPrompt('base', [entry('pd__list')], '   ')).not.toContain('House rules');
  });

  it('still appends them when no tools are connected', () => {
    const out = buildSystemPrompt('base', [], 'Call me boss.');
    expect(out).toContain('No MCP servers are currently connected');
    expect(out).toContain('Call me boss.');
  });

  it('groups the catalogue by server', () => {
    const out = buildSystemPrompt('base', [entry('pd__a'), entry('sre__b', 'SRE Agent')]);
    expect(out).toContain('### PagerDuty');
    expect(out).toContain('### SRE Agent');
  });
});

describe('the skill index', () => {
  const skill = (name: string, body = 'x'.repeat(4000)) => ({
    id: name,
    name,
    whenToUse: `Doing ${name} work.`,
    body,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('lists each skill by name and when it applies', () => {
    const out = buildSystemPrompt('base', [entry('pd__a')], undefined, [skill('rundeck_job')]);
    expect(out).toContain('## Skills');
    expect(out).toContain('- rundeck_job: Doing rundeck_job work.');
  });

  it('never puts a skill body in the prompt — that is the entire point', () => {
    // A skill exists so an operator can write pages of procedure without
    // spending pages of prompt. Inlining the body would defeat it silently,
    // and the prompt would grow without anyone noticing until it broke.
    const big = 'SECRET_PROCEDURE_TEXT'.repeat(400);
    const out = buildSystemPrompt('base', [entry('pd__a')], undefined, [skill('rundeck_job', big)]);
    expect(out).not.toContain('SECRET_PROCEDURE_TEXT');
    expect(out.length).toBeLessThan(6000);
  });

  it('tells her to open the skill before starting, not after', () => {
    const out = buildSystemPrompt('base', [entry('pd__a')], undefined, [skill('rundeck_job')]);
    expect(out).toMatch(/before you start work/i);
    expect(out).toContain('skill__open');
  });

  it('adds no section at all when there are no skills', () => {
    expect(buildSystemPrompt('base', [entry('pd__a')])).not.toContain('## Skills');
    expect(buildSystemPrompt('base', [entry('pd__a')], undefined, [])).not.toContain('## Skills');
  });

  it('keeps house rules ahead of the index so both survive', () => {
    const out = buildSystemPrompt('base', [entry('pd__a')], 'Call me boss.', [skill('rundeck_job')]);
    expect(out).toContain('Call me boss.');
    expect(out).toContain('- rundeck_job:');
  });
});

describe('screen guidance', () => {
  it('tells the agent to mirror filtered data onto the screen', () => {
    // The screen only shows raw tool results, so a filter done in her head
    // leaves the engineer reading a different list than the one she describes.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('screen__show');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/as well as answering out loud/i);
  });
});

describe('ending guidance', () => {
  it('tells the agent that "that\'s all" means end the session', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('session__end');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/short goodbye/i);
  });
});
