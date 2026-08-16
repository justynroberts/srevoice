import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { deriveKey, open, seal } from '../crypto/seal.js';
import { logger } from '../logger.js';

const FILENAME = 'authored.sealed';
const MAX_RECORDS = 2000;

export const authoredJobSchema = z.object({
  /** Rundeck's job UUID — the thing a run request names. */
  jobId: z.string().min(1),
  name: z.string().default(''),
  project: z.string().default(''),
  createdAt: z.string(),
});

export type AuthoredJob = z.infer<typeof authoredJobSchema>;

const fileSchema = z.object({
  version: z.literal(1).default(1),
  jobs: z.array(authoredJobSchema).default([]),
});

/**
 * Every automation job the agent wrote.
 *
 * Writing a job means composing arbitrary shell commands; running it executes
 * them on real infrastructure. Doing both unsupervised is a different class of
 * risk from starting a workflow someone already reviewed and approved — so the
 * two are separated, and this is the record that makes the separation
 * enforceable rather than merely requested in a prompt.
 *
 * Persisted, because the point is to still refuse tomorrow, in a session that
 * knows nothing about the one that wrote the job. Sealed like everything else
 * here, since job names carry project and service names.
 */
export class AuthoredJobStore {
  private readonly path: string;
  private readonly key: Buffer | null;
  private cache: AuthoredJob[] | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, masterKeyMaterial?: string) {
    this.path = join(dataDir, FILENAME);
    this.key = masterKeyMaterial ? deriveKey(masterKeyMaterial) : null;
  }

  async all(): Promise<AuthoredJob[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      const json = this.key ? open(raw, this.key) : raw;
      this.cache = fileSchema.parse(JSON.parse(json)).jobs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Deliberately loud. An unreadable record means the guard silently
        // stops guarding, which is the one failure that must not pass quietly.
        logger.error({ err: (err as Error).message }, 'Could not read authored-job record');
      }
      this.cache = [];
    }
    return this.cache;
  }

  async find(jobId: string): Promise<AuthoredJob | undefined> {
    const wanted = jobId.trim().toLowerCase();
    return (await this.all()).find((j) => j.jobId.toLowerCase() === wanted);
  }

  async record(jobs: Array<{ jobId: string; name?: string; project?: string }>): Promise<void> {
    if (jobs.length === 0) return;
    const now = new Date().toISOString();

    await this.mutate((existing) => {
      const byId = new Map(existing.map((j) => [j.jobId.toLowerCase(), j]));
      for (const job of jobs) {
        const id = job.jobId.trim();
        if (!id) continue;
        byId.set(id.toLowerCase(), {
          jobId: id,
          name: job.name ?? '',
          project: job.project ?? '',
          createdAt: byId.get(id.toLowerCase())?.createdAt ?? now,
        });
      }
      // Oldest first out, so the newest authorship is what survives a cap that
      // should never be reached in practice.
      return [...byId.values()].slice(-MAX_RECORDS);
    });

    logger.info({ count: jobs.length }, 'Recorded agent-authored job(s)');
  }

  private async mutate(fn: (jobs: AuthoredJob[]) => AuthoredJob[]): Promise<AuthoredJob[]> {
    const run = async () => {
      const next = fn([...(await this.all())]);
      await this.persist(next);
      this.cache = next;
      return next;
    };
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.catch(() => undefined);
    return chained;
  }

  private async persist(jobs: AuthoredJob[]): Promise<void> {
    const json = JSON.stringify({ version: 1, jobs }, null, 2);
    const payload = this.key ? seal(json, this.key) : json;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path);
  }
}
