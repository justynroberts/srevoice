import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskSecret } from '../logger.js';
import { isAllowedMcpUrl, redactSettings } from './schema.js';
import { SettingsStore } from './settings.js';

const MASTER_KEY = 'IGoAP0K5aH2Yy1qz8VbC3nJd7Lm4Rt6Xw9Ee0Uu5Iio=';

describe('SettingsStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'srevoice-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns defaults when nothing has been saved', async () => {
    const store = new SettingsStore(dir, MASTER_KEY);
    const settings = await store.load();
    expect(settings.mcpServers).toEqual([]);
    expect(settings.elevenlabsApiKey).toBeUndefined();
    expect(settings.voice.modelId).toBe('eleven_flash_v2');
  });

  it('persists across instances and never writes plaintext secrets', async () => {
    const store = new SettingsStore(dir, MASTER_KEY);
    await store.update((s) => {
      s.elevenlabsApiKey = 'sk_supersecret_value';
      s.mcpServers = [
        {
          id: 'pd',
          label: 'PagerDuty',
          url: 'https://mcp.pagerduty.com/mcp',
          headers: { Authorization: 'Bearer pd_token_here' },
          enabled: true,
        },
      ];
      return s;
    });

    const onDisk = await readFile(join(dir, 'settings.sealed'), 'utf8');
    expect(onDisk).not.toContain('sk_supersecret_value');
    expect(onDisk).not.toContain('pd_token_here');
    expect(onDisk.startsWith('srev1.')).toBe(true);

    const reopened = new SettingsStore(dir, MASTER_KEY);
    const settings = await reopened.load();
    expect(settings.elevenlabsApiKey).toBe('sk_supersecret_value');
    expect(settings.mcpServers[0].headers.Authorization).toBe('Bearer pd_token_here');
  });

  it('refuses to decrypt with a different master key', async () => {
    const store = new SettingsStore(dir, MASTER_KEY);
    await store.update((s) => {
      s.elevenlabsApiKey = 'sk_abc';
      return s;
    });

    const wrong = new SettingsStore(dir, 'a-completely-different-key');
    await expect(wrong.load()).rejects.toThrow(/does not match/);
  });

  it('serialises concurrent updates without losing a write', async () => {
    const store = new SettingsStore(dir, MASTER_KEY);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.update((s) => {
          s.mcpServers = [
            ...s.mcpServers,
            { id: `srv${i}`, label: `Server ${i}`, url: `https://example.com/${i}`, headers: {}, enabled: true },
          ];
          return s;
        }),
      ),
    );

    const reopened = new SettingsStore(dir, MASTER_KEY);
    expect((await reopened.load()).mcpServers).toHaveLength(8);
  });

  it('keeps the write chain alive after a failed update', async () => {
    const store = new SettingsStore(dir, MASTER_KEY);
    await expect(
      store.update(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await store.update((s) => {
      s.agent.name = 'Still working';
      return s;
    });
    expect((await store.load()).agent.name).toBe('Still working');
  });
});

describe('redactSettings', () => {
  it('masks every secret it exposes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'srevoice-redact-'));
    try {
      const store = new SettingsStore(dir, MASTER_KEY);
      const settings = await store.update((s) => {
        s.elevenlabsApiKey = 'sk_1234567890abcdef';
        s.mcpServers = [
          {
            id: 'pd',
            label: 'PagerDuty',
            url: 'https://mcp.pagerduty.com/mcp',
            headers: { Authorization: 'Bearer aaaabbbbccccdddd' },
            enabled: true,
          },
        ];
        return s;
      });

      const view = redactSettings(settings, maskSecret);
      const serialised = JSON.stringify(view);

      expect(serialised).not.toContain('sk_1234567890abcdef');
      expect(serialised).not.toContain('aaaabbbbccccdddd');
      expect(view.elevenlabs.configured).toBe(true);
      expect(view.elevenlabs.preview).toBe('sk_1••••cdef');
      expect(view.mcpServers[0].headerNames).toEqual(['Authorization']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('isAllowedMcpUrl', () => {
  it('accepts https anywhere', () => {
    expect(isAllowedMcpUrl('https://mcp.pagerduty.com/mcp')).toBe(true);
  });

  it('accepts http only to hosts that cannot be routed from outside', () => {
    // A container-network sidecar has no public name and so cannot hold a
    // certificate; a single-label hostname is what marks it as internal.
    expect(isAllowedMcpUrl('http://mcp-bridge:8080/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://localhost:8080/mcp')).toBe(true);
    expect(isAllowedMcpUrl('http://127.0.0.1:8080/mcp')).toBe(true);
  });

  it('rejects plaintext to anything routable', () => {
    expect(isAllowedMcpUrl('http://mcp.pagerduty.com/mcp')).toBe(false);
    expect(isAllowedMcpUrl('http://192.168.1.10/mcp')).toBe(false);
    expect(isAllowedMcpUrl('http://evil.example.com/mcp')).toBe(false);
  });

  it('rejects anything that is not http(s)', () => {
    expect(isAllowedMcpUrl('ws://mcp-bridge/mcp')).toBe(false);
    expect(isAllowedMcpUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedMcpUrl('not a url')).toBe(false);
  });
});

describe('secrets are keyed on the server id', () => {
  // The browser only ever holds a masked preview, so it sends null meaning
  // "keep what is stored". That lookup is by id — change the id and it misses.
  // Silently dropping the header there returned 200 while the endpoint began
  // answering 401, which is how the Rundeck bridge lost its bearer token.
  const resolve = (
    stored: { id: string; headers: Record<string, string> }[],
    incoming: { id: string; headers: Record<string, string | null> },
  ) => {
    const previous = new Map(stored.map((s) => [s.id, s]));
    const before = previous.get(incoming.id);
    const out: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const [key, value] of Object.entries(incoming.headers)) {
      const found = value ?? before?.headers[key];
      if (found) out[key] = found;
      else unresolved.push(key);
    }
    return { headers: out, unresolved };
  };

  it('keeps a stored secret when the id is unchanged', () => {
    const result = resolve(
      [{ id: 'rd', headers: { Authorization: 'Bearer real-token' } }],
      { id: 'rd', headers: { Authorization: null } },
    );
    expect(result.headers.Authorization).toBe('Bearer real-token');
    expect(result.unresolved).toEqual([]);
  });

  it('cannot resolve the secret once the id changes', () => {
    const result = resolve(
      [{ id: 'rd', headers: { Authorization: 'Bearer real-token' } }],
      { id: 'rundeck', headers: { Authorization: null } },
    );
    // The route must reject this rather than save a server with no credential.
    expect(result.unresolved).toEqual(['Authorization']);
    expect(result.headers).toEqual({});
  });

  it('takes an explicitly supplied value over the stored one', () => {
    const result = resolve(
      [{ id: 'rd', headers: { Authorization: 'Bearer old' } }],
      { id: 'rd', headers: { Authorization: 'Bearer new' } },
    );
    expect(result.headers.Authorization).toBe('Bearer new');
  });
});
