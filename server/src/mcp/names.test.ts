import { describe, expect, it } from 'vitest';
import { qualify, sanitiseToolName, unqualify } from './names.js';

describe('sanitiseToolName', () => {
  it('replaces characters ElevenLabs will not accept', () => {
    expect(sanitiseToolName('pagerduty.list-incidents')).toBe('pagerduty_list-incidents');
    expect(sanitiseToolName('a//b')).toBe('a_b');
    expect(sanitiseToolName('_leading_and_trailing_')).toBe('leading_and_trailing');
  });
});

describe('qualify / unqualify', () => {
  it('round-trips a normal name', () => {
    const q = qualify('pd', 'list_incidents');
    expect(q).toBe('pd__list_incidents');
    expect(unqualify(q)).toEqual({ serverId: 'pd', toolName: 'list_incidents' });
  });

  it('keeps the server prefix routable when the name is too long', () => {
    const q = qualify('pd', 'x'.repeat(200));
    expect(q.length).toBeLessThanOrEqual(64);
    expect(q.startsWith('pd__')).toBe(true);
    expect(unqualify(q)?.serverId).toBe('pd');
  });

  it('throws when the server id leaves no room for a tool name', () => {
    expect(() => qualify('s'.repeat(62), 'tool')).toThrow(/too long/);
  });

  it('rejects a name with no separator', () => {
    expect(unqualify('nolongseparator')).toBeNull();
    expect(unqualify('__leading')).toBeNull();
  });
});
