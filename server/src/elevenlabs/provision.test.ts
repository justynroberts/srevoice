import { describe, expect, it } from 'vitest';
import { ttsModelFor } from './provision.js';

describe('ttsModelFor', () => {
  it('keeps the English-only v2 models as-is', () => {
    expect(ttsModelFor('eleven_flash_v2', 'en')).toBe('eleven_flash_v2');
    expect(ttsModelFor('eleven_turbo_v2', 'en-GB')).toBe('eleven_turbo_v2');
  });

  it('coerces the multilingual _v2_5 variants, which English agents reject', () => {
    // The exact failure seen in production: "English Agents must use turbo or
    // flash v2." A `v2` prefix match is not enough — v2_5 is multilingual.
    expect(ttsModelFor('eleven_flash_v2_5', 'en')).toBe('eleven_flash_v2');
    expect(ttsModelFor('eleven_turbo_v2_5', 'en')).toBe('eleven_turbo_v2');
  });

  it('coerces anything else, preserving a turbo choice', () => {
    expect(ttsModelFor('eleven_multilingual_v2', 'en')).toBe('eleven_flash_v2');
    expect(ttsModelFor('eleven_v3', 'en')).toBe('eleven_flash_v2');
    expect(ttsModelFor('eleven_turbo_v3', 'en')).toBe('eleven_turbo_v2');
  });

  it('leaves non-English agents alone — the restriction is English-only', () => {
    expect(ttsModelFor('eleven_multilingual_v2', 'fr')).toBe('eleven_multilingual_v2');
    expect(ttsModelFor('eleven_multilingual_v2', 'de')).toBe('eleven_multilingual_v2');
  });
});
