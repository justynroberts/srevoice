import { describe, expect, it } from 'vitest';
import { renderToolResult } from './render.js';

describe('renderToolResult', () => {
  it('recovers JSON from a text block for the screen while speaking the text', () => {
    const result = renderToolResult({
      content: [{ type: 'text', text: '{"incidents":[{"id":"P1","title":"Checkout down"}]}' }],
    });
    expect(result.display).toEqual({ incidents: [{ id: 'P1', title: 'Checkout down' }] });
    expect(result.speech).toContain('Checkout down');
    expect(result.isError).toBe(false);
  });

  it('prefers structuredContent when the server provides it', () => {
    const result = renderToolResult({
      content: [{ type: 'text', text: 'summary line' }],
      structuredContent: { count: 3 },
    });
    expect(result.display).toEqual({ count: 3 });
    expect(result.speech).toBe('summary line');
  });

  it('keeps plain prose as-is', () => {
    const result = renderToolResult({ content: [{ type: 'text', text: 'No incidents found.' }] });
    expect(result.display).toBe('No incidents found.');
    expect(result.truncated).toBe(false);
  });

  it('passes a large payload through — cutting early forces a second query', () => {
    const large = 'x'.repeat(20_000);
    const result = renderToolResult({ content: [{ type: 'text', text: large }] });
    expect(result.truncated).toBe(false);
    expect(result.speech).toHaveLength(20_000);
  });

  it('truncates only a genuinely huge payload, leaving the display intact', () => {
    const huge = 'x'.repeat(60_000);
    const result = renderToolResult({ content: [{ type: 'text', text: huge }] });
    expect(result.truncated).toBe(true);
    expect(result.speech.length).toBeLessThan(25_000);
    expect(result.speech).toContain('full payload is on screen');
    // The screen always keeps everything.
    expect(String(result.display)).toHaveLength(60_000);
  });

  it('flags errors without throwing', () => {
    const result = renderToolResult({ content: [{ type: 'text', text: 'rate limited' }], isError: true });
    expect(result.isError).toBe(true);
    expect(result.speech).toBe('rate limited');
  });

  it('handles an empty result', () => {
    const result = renderToolResult({ content: [] });
    expect(result.speech).toBe('The tool returned no content.');
  });
});
