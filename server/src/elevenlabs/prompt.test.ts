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

describe('screen guidance', () => {
  it('tells the agent to mirror filtered data onto the screen', () => {
    // The screen only shows raw tool results, so a filter done in her head
    // leaves the engineer reading a different list than the one she describes.
    expect(DEFAULT_SYSTEM_PROMPT).toContain('screen__show');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/as well as answering out loud/i);
  });
});
