import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { deriveKey, open, seal } from '../crypto/seal.js';
import { logger } from '../logger.js';

const FILENAME = 'skills.sealed';
const MAX_SKILLS = 40;
const MAX_BODY = 20_000;

export const skillSchema = z.object({
  id: z.string(),
  /**
   * What the agent passes to `skill__open`. Slug-shaped because it is spoken
   * back in tool calls and has to survive being read, typed and logged.
   */
  name: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9_]*$/, 'name must be lowercase letters, numbers and underscores'),
  /**
   * The single line that goes in the system prompt. This is the whole basis on
   * which the agent decides whether to open the skill, so it describes the
   * situation, not the contents.
   */
  whenToUse: z.string().min(1).max(240),
  /** The instructions themselves — only ever loaded on demand. */
  body: z.string().min(1).max(MAX_BODY),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Skill = z.infer<typeof skillSchema>;

const fileSchema = z.object({
  version: z.literal(1).default(1),
  /** Set once, so deleting the starter skill does not bring it back. */
  seeded: z.boolean().default(false),
  skills: z.array(skillSchema).default([]),
});

/**
 * The starter skill. Present because "how do I write a Rundeck job" is exactly
 * the kind of knowledge that is too long for the system prompt and needed only
 * occasionally — which is the case skills exist to serve. Editable and
 * deletable like any other.
 */
const STARTER: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'> = {
  name: 'rundeck_job',
  whenToUse:
    'Creating, validating or importing a Rundeck job, or asked to automate a runbook step as a job.',
  body: `# Writing and importing a Rundeck job

Work in this order. Do not skip validation — an invalid job is accepted by the
API as a 200 with a failed entry inside it, which is easy to misread as success.

## 1. Draft it
Use rd__job_create to generate the definition rather than writing YAML by hand.
Give it name, project, description and workflow_steps.

## 2. Validate it
Pass the generated YAML to rd__job_validate with format: 'yaml'. Fix anything it
reports before going near the import endpoint.

## 3. Import it
One call to rd__api_call:

- endpoint: project/{project}/jobs/import
- method: POST
- body: the YAML, as a plain string
- content_type: application/yaml
- query_params: { fileformat: 'yaml', dupeOption: 'update' }

dupeOption 'update' overwrites a job of the same name; use 'skip' when you must
not touch an existing one, and say which you used.

## 4. Confirm it
The response body carries 'succeeded' and 'failed' lists. Check them — do not
report success on the strength of the status code alone. Then say the job name
and project out loud, and put the result on screen.

## House rules
- Creating or updating a job changes a real system: state exactly what you are
  about to do and wait for a yes.
- Never run a job as part of creating it unless you were asked to.
- If the project does not exist, stop and say so. Do not create one.`,
  enabled: true,
};

/**
 * Named blocks of instruction the agent loads only when the work calls for it.
 *
 * The system prompt carries one line per skill — its name and when to use it —
 * and nothing else. Everything else arrives through `skill__open`. This keeps
 * the base prompt small regardless of how much an operator writes: twenty
 * skills cost twenty lines until one is actually needed.
 *
 * Sealed like settings and memory: a house convention frequently names hosts,
 * projects and ownership an operator would not want sitting in the clear.
 */
export class SkillStore {
  private readonly path: string;
  private readonly key: Buffer | null;
  private cache: { seeded: boolean; skills: Skill[] } | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, masterKeyMaterial?: string) {
    this.path = join(dataDir, FILENAME);
    this.key = masterKeyMaterial ? deriveKey(masterKeyMaterial) : null;
  }

  private async read(): Promise<{ seeded: boolean; skills: Skill[] }> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      const json = this.key ? open(raw, this.key) : raw;
      const parsed = fileSchema.parse(JSON.parse(json));
      this.cache = { seeded: parsed.seeded, skills: parsed.skills };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: (err as Error).message }, 'Could not read skills — starting empty');
      }
      this.cache = { seeded: false, skills: [] };
    }
    return this.cache;
  }

  async all(): Promise<Skill[]> {
    const state = await this.read();
    // Seeded on first read rather than at construction, so a fresh install gets
    // a worked example without a migration step.
    if (!state.seeded) {
      const now = new Date().toISOString();
      return this.mutate((skills) => [
        ...skills,
        { ...STARTER, id: randomUUID(), createdAt: now, updatedAt: now },
      ], true);
    }
    return state.skills;
  }

  /** Only what the agent is allowed to reach: enabled skills. */
  async active(): Promise<Skill[]> {
    return (await this.all()).filter((s) => s.enabled);
  }

  async find(name: string): Promise<Skill | undefined> {
    const wanted = name.trim().toLowerCase();
    return (await this.active()).find((s) => s.name === wanted);
  }

  async create(input: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>): Promise<Skill> {
    const now = new Date().toISOString();
    const skill: Skill = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.mutate((skills) => {
      // A name is a routing key; two skills answering to it is a coin toss.
      const without = skills.filter((s) => s.name !== skill.name);
      return [...without, skill];
    });
    return skill;
  }

  async update(id: string, patch: Partial<Omit<Skill, 'id' | 'createdAt'>>): Promise<Skill | undefined> {
    const next = await this.mutate((skills) =>
      skills.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s)),
    );
    return next.find((s) => s.id === id);
  }

  async remove(id: string): Promise<boolean> {
    const before = (await this.all()).length;
    const after = await this.mutate((skills) => skills.filter((s) => s.id !== id));
    return after.length < before;
  }

  private async mutate(fn: (skills: Skill[]) => Skill[], markSeeded = false): Promise<Skill[]> {
    const run = async () => {
      const state = await this.read();
      const next = fn([...state.skills]).slice(0, MAX_SKILLS);
      const seeded = state.seeded || markSeeded;
      await this.persist(seeded, next);
      this.cache = { seeded, skills: next };
      return next;
    };
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.catch(() => undefined);
    return chained;
  }

  private async persist(seeded: boolean, skills: Skill[]): Promise<void> {
    const json = JSON.stringify({ version: 1, seeded, skills }, null, 2);
    const payload = this.key ? seal(json, this.key) : json;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path);
  }
}
