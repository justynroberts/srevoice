import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { deriveKey, open, seal } from '../crypto/seal.js';
import { logger } from '../logger.js';

const FILENAME = 'memory.sealed';
const MAX_NOTES = 500;
const MAX_TEXT = 2000;

export const noteSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(MAX_TEXT),
  tag: z.string().max(40).optional(),
  createdAt: z.string(),
  /** Bumped whenever the note is recalled, so useful notes float up. */
  usedAt: z.string().optional(),
  /** Pinned notes are always injected at session start, never trimmed. */
  pinned: z.boolean().default(false),
});

export type Note = z.infer<typeof noteSchema>;

const fileSchema = z.object({
  version: z.literal(1).default(1),
  notes: z.array(noteSchema).default([]),
});

/**
 * What Paige knows between sessions — conventions, ownership, the shape of a
 * recurring failure. Sealed like settings, because an operator will inevitably
 * record something about their infrastructure they would not want in the clear.
 *
 * Deliberately notes rather than transcripts: a full conversation log would be
 * mostly noise, would grow without bound, and would put every incident detail
 * on disk. She writes down what she judges worth keeping.
 */
export class MemoryStore {
  private readonly path: string;
  private readonly key: Buffer | null;
  private cache: Note[] | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, masterKeyMaterial?: string) {
    this.path = join(dataDir, FILENAME);
    this.key = masterKeyMaterial ? deriveKey(masterKeyMaterial) : null;
  }

  async all(): Promise<Note[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      const json = this.key ? open(raw, this.key) : raw;
      this.cache = fileSchema.parse(JSON.parse(json)).notes;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: (err as Error).message }, 'Could not read memory — starting empty');
      }
      this.cache = [];
    }
    return this.cache;
  }

  private async mutate(fn: (notes: Note[]) => Note[]): Promise<Note[]> {
    const run = async () => {
      const next = fn([...(await this.all())]);
      // Oldest unpinned notes go first once the cap is reached.
      const trimmed =
        next.length <= MAX_NOTES
          ? next
          : [...next.filter((n) => n.pinned), ...next.filter((n) => !n.pinned).slice(-MAX_NOTES)];
      await this.persist(trimmed);
      this.cache = trimmed;
      return trimmed;
    };
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.catch(() => undefined);
    return chained;
  }

  async remember(text: string, tag?: string): Promise<Note> {
    const clean = text.trim().slice(0, MAX_TEXT);
    const note: Note = {
      id: randomUUID(),
      text: clean,
      tag: tag?.trim().slice(0, 40) || undefined,
      createdAt: new Date().toISOString(),
      pinned: false,
    };

    await this.mutate((notes) => {
      // Near-duplicates accumulate fast when an agent re-learns the same fact,
      // so replace rather than append.
      const normalised = clean.toLowerCase();
      const without = notes.filter((n) => n.text.toLowerCase() !== normalised);
      return [...without, note];
    });
    return note;
  }

  async forget(id: string): Promise<boolean> {
    const before = (await this.all()).length;
    const after = await this.mutate((notes) => notes.filter((n) => n.id !== id));
    return after.length < before;
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.mutate((notes) => notes.map((n) => (n.id === id ? { ...n, pinned } : n)));
  }

  async clear(): Promise<void> {
    await this.mutate(() => []);
  }

  /** Naive term match — the corpus is small and an index would be overkill. */
  async recall(query: string, limit = 12): Promise<Note[]> {
    const notes = await this.all();
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) return this.forSessionStart(limit);

    const scored = notes
      .map((note) => {
        const haystack = `${note.text} ${note.tag ?? ''}`.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
        return { note, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const now = new Date().toISOString();
    if (scored.length > 0) {
      const hit = new Set(scored.map((s) => s.note.id));
      void this.mutate((notes) => notes.map((n) => (hit.has(n.id) ? { ...n, usedAt: now } : n)));
    }
    return scored.map((s) => s.note);
  }

  /** Pinned first, then most recent — what she gets handed at session start. */
  async forSessionStart(limit = 40): Promise<Note[]> {
    const notes = await this.all();
    const pinned = notes.filter((n) => n.pinned);
    const rest = notes.filter((n) => !n.pinned).slice(-Math.max(0, limit - pinned.length));
    return [...pinned, ...rest];
  }

  private async persist(notes: Note[]): Promise<void> {
    const json = JSON.stringify({ version: 1, notes }, null, 2);
    const payload = this.key ? seal(json, this.key) : json;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path);
  }
}
