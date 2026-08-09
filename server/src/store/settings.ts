import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deriveKey, open, seal, SealError } from '../crypto/seal.js';
import { logger } from '../logger.js';
import { emptySettings, settingsSchema, type Settings } from './schema.js';

const FILENAME = 'settings.sealed';

/**
 * Single-writer, whole-file settings store. The data is tiny (a handful of
 * keys and MCP endpoints) and written only from the settings page, so a
 * database would be pure overhead — but it holds live credentials, so it is
 * sealed at rest and written atomically.
 */
export class SettingsStore {
  private readonly path: string;
  private readonly key: Buffer | null;
  private cache: Settings | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, masterKeyMaterial?: string) {
    this.path = join(dataDir, FILENAME);
    this.key = masterKeyMaterial ? deriveKey(masterKeyMaterial) : null;
    if (!this.key) {
      logger.warn(
        'SREVOICE_MASTER_KEY is not set — settings will be stored as plaintext. Never do this in production.',
      );
    }
  }

  async load(): Promise<Settings> {
    if (this.cache) return this.cache;

    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = emptySettings();
        return this.cache;
      }
      throw err;
    }

    const json = this.key ? open(raw, this.key) : raw;
    const parsed = settingsSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      // Refuse to silently drop credentials we can read but not validate.
      throw new SealError(
        `Stored settings failed validation: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    }
    this.cache = parsed.data;
    return this.cache;
  }

  /**
   * Serialises mutations so two concurrent saves cannot interleave a
   * read-modify-write and lose one of them.
   */
  async update(mutate: (current: Settings) => Settings | Promise<Settings>): Promise<Settings> {
    const run = async (): Promise<Settings> => {
      const current = await this.load();
      const next = settingsSchema.parse(await mutate(structuredClone(current)));
      next.updatedAt = new Date().toISOString();
      await this.persist(next);
      this.cache = next;
      return next;
    };
    const chained = this.writeChain.then(run, run);
    // Keep the chain alive even when a caller's write rejects.
    this.writeChain = chained.catch(() => undefined);
    return chained;
  }

  private async persist(settings: Settings): Promise<void> {
    const json = JSON.stringify(settings, null, 2);
    const payload = this.key ? seal(json, this.key) : json;

    await mkdir(dirname(this.path), { recursive: true });
    // Atomic replace: a torn write here would cost every stored credential.
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path);
  }

  /** Test seam — drops the in-memory copy so the next load re-reads disk. */
  invalidate(): void {
    this.cache = null;
  }
}
