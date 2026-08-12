import { describe, expect, it } from 'vitest';
import { ttsModelFor } from './provision.js';

describe('ttsModelFor', () => {
  it('keeps turbo and flash v2 models for English agents', () => {
    expect(ttsModelFor('eleven_flash_v2_5', 'en')).toBe('eleven_flash_v2_5');
    expect(ttsModelFor('eleven_turbo_v2_5', 'en')).toBe('eleven_turbo_v2_5');
    expect(ttsModelFor('eleven_flash_v2', 'en-GB')).toBe('eleven_flash_v2');
  });

  it('coerces a model ElevenLabs would reject for an English agent', () => {
    // The exact failure seen in production: "English Agents must use turbo or
    // flash v2."
    expect(ttsModelFor('eleven_multilingual_v2', 'en')).toBe('eleven_flash_v2_5');
    expect(ttsModelFor('eleven_v3', 'en')).toBe('eleven_flash_v2_5');
  });

  it('leaves non-English agents alone — the restriction is English-only', () => {
    expect(ttsModelFor('eleven_multilingual_v2', 'fr')).toBe('eleven_multilingual_v2');
    expect(ttsModelFor('eleven_multilingual_v2', 'de')).toBe('eleven_multilingual_v2');
  });
});
