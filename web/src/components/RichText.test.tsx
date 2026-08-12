import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RichText, SpokenText } from './RichText';

// Auto-cleanup only happens with vitest globals; assertions here query the
// whole document, so a leftover render from the previous case would match.
afterEach(cleanup);

describe('RichText — the results panel', () => {
  it('renders headings, emphasis and lists rather than raw syntax', () => {
    render(<RichText text={'## Impact\n\n**checkout-api** is down.\n\n- one\n- two'} />);

    expect(screen.getByText('Impact').tagName).toBe('H3');
    expect(screen.getByText('checkout-api').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // The literal markers must not survive into the output.
    expect(document.body.textContent).not.toContain('##');
    expect(document.body.textContent).not.toContain('**');
  });

  it('renders GFM tables', () => {
    render(<RichText text={'| Service | Status |\n| --- | --- |\n| checkout | down |'} />);

    const table = screen.getByRole('table');
    expect(within(table).getByText('Service')).toBeDefined();
    expect(within(table).getByText('down')).toBeDefined();
  });

  it('renders a fenced block with its language and line count', () => {
    render(<RichText text={'```sql\nSELECT 1;\nSELECT 2;\n```'} />);

    expect(screen.getByText('sql')).toBeDefined();
    expect(screen.getByText('2 lines')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
    // The fence markers themselves must not leak through.
    expect(document.body.textContent).not.toContain('```');
  });

  it('handles a fence with no language', () => {
    render(<RichText text={'```\nplain text\n```'} />);
    expect(screen.getByText('code')).toBeDefined();
  });

  it('opens links in a new tab without leaking the referrer', () => {
    render(<RichText text={'[incident](https://example.com/i/1)'} />);

    const link = screen.getByRole('link', { name: 'incident' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('does not render raw HTML — tool output is third-party data', () => {
    render(<RichText text={'<img src=x onerror="alert(1)">  and <b>bold</b>'} />);

    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('SpokenText — the transcript', () => {
  it('leaves identifiers alone instead of parsing them as markdown', () => {
    // Parsing speech as markdown would turn checkout_api_v2 into italics and
    // silently drop the underscores.
    render(<SpokenText text="Restart checkout_api_v2 and _then_ check *the* logs." />);

    expect(document.body.textContent).toContain('checkout_api_v2');
    expect(document.body.textContent).toContain('_then_');
    expect(document.body.textContent).toContain('*the*');
    expect(document.querySelector('em')).toBeNull();
  });

  it('still styles backticked identifiers', () => {
    render(<SpokenText text="Look at `checkout-api` first." />);
    expect(screen.getByText('checkout-api').tagName).toBe('CODE');
  });
});
