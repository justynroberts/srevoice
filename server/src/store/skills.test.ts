import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillStore } from './skills.js';

const MASTER_KEY = 'IGoAP0K5aH2Yy1qz8VbC3nJd7Lm4Rt6Xw9Ee0Uu5Iio=';

describe('SkillStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'srevoice-skills-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ships worked examples so the feature is discoverable', async () => {
    const names = (await new SkillStore(dir, MASTER_KEY).all()).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['rundeck_job', 'incident_review', 'incident_workflow']));
  });

  it('adds a starter introduced after the install was first seeded', async () => {
    // Starters used to be tracked by a single boolean, so an install seeded
    // once could never receive one added later.
    const store = new SkillStore(dir, MASTER_KEY);
    const first = await store.all();
    const victim = first.find((s) => s.name === 'incident_review')!;
    await store.remove(victim.id);

    // A reopened store must not resurrect the deleted one...
    const reopened = new SkillStore(dir, MASTER_KEY);
    const names = (await reopened.all()).map((s) => s.name);
    expect(names).not.toContain('incident_review');
    // ...while the others stay put.
    expect(names).toContain('rundeck_job');
    expect(names).toContain('incident_workflow');
  });

  it('never overwrites a skill the operator wrote under a starter name', async () => {
    const store = new SkillStore(dir, MASTER_KEY);
    await store.all();
    const mine = (await store.all()).find((s) => s.name === 'incident_workflow')!;
    await store.update(mine.id, { body: 'MY OWN PROCEDURE' });

    const reopened = new SkillStore(dir, MASTER_KEY);
    const found = (await reopened.all()).filter((s) => s.name === 'incident_workflow');
    expect(found).toHaveLength(1);
    expect(found[0].body).toBe('MY OWN PROCEDURE');
  });

  it('does not resurrect a starter once it has been deleted', async () => {
    // Otherwise deleting it looks like it worked and it reappears on restart.
    const store = new SkillStore(dir, MASTER_KEY);
    const starter = (await store.all()).find((s) => s.name === 'rundeck_job');
    expect(await store.remove(starter!.id)).toBe(true);

    const names = (await new SkillStore(dir, MASTER_KEY).all()).map((s) => s.name);
    expect(names).not.toContain('rundeck_job');
  });

  it('seals the body on disk', async () => {
    const store = new SkillStore(dir, MASTER_KEY);
    await store.create({
      name: 'house_style',
      whenToUse: 'Anything involving the payments cluster.',
      body: 'The payments cluster lives at internal-host-42.',
      enabled: true,
    });

    const onDisk = await readFile(join(dir, 'skills.sealed'), 'utf8');
    expect(onDisk).not.toContain('internal-host-42');
    expect(onDisk.startsWith('srev1.')).toBe(true);
  });

  it('treats the name as a routing key and keeps it unique', async () => {
    const store = new SkillStore(dir, MASTER_KEY);
    await store.create({ name: 'dupe', whenToUse: 'first', body: 'first body', enabled: true });
    await store.create({ name: 'dupe', whenToUse: 'second', body: 'second body', enabled: true });

    const matching = (await store.all()).filter((s) => s.name === 'dupe');
    expect(matching).toHaveLength(1);
    expect(matching[0].body).toBe('second body');
  });

  it('hides disabled skills from the agent but keeps them for the operator', async () => {
    const store = new SkillStore(dir, MASTER_KEY);
    const skill = await store.create({
      name: 'draft',
      whenToUse: 'Not ready yet.',
      body: 'unfinished',
      enabled: false,
    });

    expect((await store.active()).map((s) => s.name)).not.toContain('draft');
    expect((await store.all()).map((s) => s.name)).toContain('draft');
    expect(await store.find('draft')).toBeUndefined();

    await store.update(skill.id, { enabled: true });
    expect(await store.find('draft')).toMatchObject({ name: 'draft' });
  });

  it('looks up case-insensitively, since the name comes back through speech', async () => {
    const store = new SkillStore(dir, MASTER_KEY);
    await store.create({ name: 'rollback', whenToUse: 'x', body: 'y', enabled: true });
    expect(await store.find('ROLLBACK')).toMatchObject({ name: 'rollback' });
  });

  it('survives a restart', async () => {
    const store = new SkillStore(dir, MASTER_KEY);
    await store.create({ name: 'persisted', whenToUse: 'x', body: 'y', enabled: true });

    const names = (await new SkillStore(dir, MASTER_KEY).all()).map((s) => s.name);
    expect(names).toContain('persisted');
  });
});
