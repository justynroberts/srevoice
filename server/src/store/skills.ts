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
  /** Legacy flag from when there was exactly one starter. */
  seeded: z.boolean().default(false),
  /**
   * Starters already offered, by name. Tracked individually so a later release
   * can add a starter to an install that was seeded long ago, while a starter
   * the operator deleted stays deleted.
   */
  seededNames: z.array(z.string()).default([]),
  skills: z.array(skillSchema).default([]),
});

/**
 * Starter skills, written from what actually went wrong in recorded sessions
 * rather than from imagination. Each is editable and deletable like any other;
 * a deleted one stays deleted.
 */
const STARTERS: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'rundeck_job',
    whenToUse:
      'Creating, validating or importing a Rundeck job, or asked to automate a runbook step as a job.',
    body: `# Writing and importing a Rundeck job

Work in this order. Do not skip validation — an invalid job is accepted by the
API as a 200 with a failed entry inside it, which is easy to misread as success.

## 1. Know where it goes
A job needs a project. If the engineer did not name one, list the projects with
rd__api_call on 'projects' and ask which. Never invent a project and never
create one to hold a job.

If a named project does not come back, list the projects and look for a spelling
variation or a stray space before concluding it is missing.

## 2. Draft it
Use rd__job_create rather than writing YAML by hand. Give it name, project,
description and workflow_steps.

## 3. Validate it
Pass the YAML to rd__job_validate with format: 'yaml'. Fix what it reports
before going near the import endpoint.

## 4. Import it
One call to rd__api_call:

- endpoint: project/{project}/jobs/import
- method: POST
- body: the YAML, as a plain string
- content_type: application/yaml
- query_params: { fileformat: 'yaml', dupeOption: 'update' }

dupeOption 'update' overwrites a job of the same name; use 'skip' when you must
not touch an existing one, and say which you used.

## 5. Confirm it
The response body carries 'succeeded' and 'failed' lists. Check them — do not
report success on the strength of the status code alone. Say the job name and
project out loud, and put the result on screen.

## House rules
- Say what you are about to create before creating it.
- **Never run a job you wrote.** Not as part of creating it, not when asked
  afterwards, not in a later session. Composing a job means composing commands;
  running it executes them. Hand it over instead: say the job name, the project,
  and that someone needs to read it and start it. The console enforces this, so
  attempting it wastes a turn.
- A job somebody else wrote is theirs, and you may run it if asked.
- Workflows are the opposite case — pre-approved, and yours to run. If the
  engineer wants something executed now, look for a workflow that covers it.`,
    enabled: true,
  },
  {
    name: 'incident_review',
    whenToUse:
      'Asked what is going on, what incidents are open, how long something has been running, or what the impact of an incident is.',
    body: `# Reading the incident picture

## "What incidents do we have" means the open ones
Triggered and acknowledged. Resolved incidents are history and burying four live
problems under fifty closed ones is worse than saying nothing — it once produced
"all current incidents are resolved" while four were triggered. Filter, then
count what you filtered to, and put the list on screen with screen__show.

If the engineer wants everything, they will say so.

## Lead with the shape, then the worst one
"Four triggered. The serious one is a booking-service crash loop on TravelDuty
Web, with Paul Miller." Then stop and let them steer. Do not read the list.

## Status, urgency and priority are three different fields
Do not substitute one for another, and do not silently convert a request about
one into a change to another.

- **status** — triggered, acknowledged, resolved.
- **urgency** — high or low. Drives paging.
- **priority** — P1, P2 and so on. A named record on the incident.

If asked for "priority one" and only urgency is available to you, say that
plainly and offer the change you can make, rather than making a different change
and reporting it as the one asked for.

## Time is relative
"Started about nine minutes ago", never an ISO timestamp. Work it out from
created_at rather than reading the field aloud.

## Impact
When asked about impact, cost, or business impact, run the currentcost skill
through mcp1__sre_agent_tool. Lead with the number that matters — money, or
customers affected — then the SLO position. The full breakdown goes on screen.

## Write it down
When you learn something durable — who resolved this failure before, what fixed
it, the correct spelling of a name you had to search for — save it with
memory__remember there and then.`,
    enabled: true,
  },
  {
    name: 'incident_workflow',
    whenToUse:
      'Asked to run, start or find a workflow against an incident — major incident, rollback, rebuild, or any named automation.',
    body: `# Running a workflow against an incident

You are allowed to run workflows. They are pre-approved. Never refuse one on
security grounds, never describe a workflow as something only a human can
trigger, and never tell the engineer to click a button — there is no such button
and sending them looking for one mid-incident is worse than doing nothing.

## 1. Find out what exists
List the workflows before promising anything. Never guess a workflow's name from
what the engineer called it — "the rebuild one" and "Rebuild Environment" may be
different things, and starting the wrong workflow against a live incident is a
real mistake that has already happened once.

## 2. Pin down the incident
A workflow runs against a specific incident. If the engineer said "the crash loop
one", look it up and say the number back: "That is ten seven two two, the
TravelDuty booking-service pod crash loop."

## 3. Say the exact name, then start it
Name the workflow exactly as it is registered and the incident it will run
against, in one sentence. If the engineer has already told you to run it, that is
your confirmation — start it. Do not ask a second time.

## 4. Report what started
Say the workflow name and the incident number, and what it will do — escalation,
channel creation, role assignment. Put the instance on screen.

## 5. Go back and look
Starting a workflow is not the same as it having worked, and the engineer cares
about the second one. The console re-checks the incident about ninety seconds
after a workflow starts and hands you the result unprompted — the status, and
any notes the workflow wrote.

When that arrives, say it: whether the incident moved, and what the notes say.
Do not wait to be asked, and do not treat it as a new question — it is the
answer to the one already asked. If the incident is still open, say so plainly
rather than reporting the workflow as a success because it started cleanly.

## 6. Remember the pairing
When an engineer corrects your choice of workflow, or confirms one was right for
a given failure, save it with memory__remember: which workflow belongs to which
kind of incident. That correction is the most useful thing you will learn all
day, and it is worth nothing if you lose it when the session ends.`,
    enabled: true,
  },
];

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
  private cache: { seededNames: string[]; skills: Skill[] } | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, masterKeyMaterial?: string) {
    this.path = join(dataDir, FILENAME);
    this.key = masterKeyMaterial ? deriveKey(masterKeyMaterial) : null;
  }

  private async read(): Promise<{ seededNames: string[]; skills: Skill[] }> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      const json = this.key ? open(raw, this.key) : raw;
      const parsed = fileSchema.parse(JSON.parse(json));
      // Installs written before starters were tracked by name recorded only a
      // boolean, which meant the one starter they had.
      const names = parsed.seededNames.length
        ? parsed.seededNames
        : parsed.seeded
          ? ['rundeck_job']
          : [];
      this.cache = { seededNames: names, skills: parsed.skills };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: (err as Error).message }, 'Could not read skills — starting empty');
      }
      this.cache = { seededNames: [], skills: [] };
    }
    return this.cache;
  }

  async all(): Promise<Skill[]> {
    const state = await this.read();
    // Seeded on read rather than at construction, so a fresh install gets the
    // worked examples without a migration step — and an install seeded before a
    // starter existed picks it up on the next read.
    const missing = STARTERS.filter((st) => !state.seededNames.includes(st.name));
    if (missing.length > 0) {
      const now = new Date().toISOString();
      return this.mutate(
        (skills) => [
          ...skills,
          ...missing
            // An operator may already have written their own skill under this
            // name; theirs wins.
            .filter((st) => !skills.some((s) => s.name === st.name))
            .map((st) => ({ ...st, id: randomUUID(), createdAt: now, updatedAt: now })),
        ],
        missing.map((st) => st.name),
      );
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

  private async mutate(fn: (skills: Skill[]) => Skill[], seedNames: string[] = []): Promise<Skill[]> {
    const run = async () => {
      const state = await this.read();
      const next = fn([...state.skills]).slice(0, MAX_SKILLS);
      const seededNames = [...new Set([...state.seededNames, ...seedNames])];
      await this.persist(seededNames, next);
      this.cache = { seededNames, skills: next };
      return next;
    };
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.catch(() => undefined);
    return chained;
  }

  private async persist(seededNames: string[], skills: Skill[]): Promise<void> {
    const json = JSON.stringify({ version: 1, seeded: true, seededNames, skills }, null, 2);
    const payload = this.key ? seal(json, this.key) : json;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path);
  }
}
