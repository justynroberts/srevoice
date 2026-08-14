import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const NAME = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_]*$/, 'name must be lowercase letters, numbers and underscores');

const createBody = z.object({
  name: NAME,
  whenToUse: z.string().min(1).max(240),
  body: z.string().min(1).max(20_000),
  enabled: z.boolean().default(true),
});

const patchBody = createBody.partial();

export const skillRoutes = (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/skills', async () => ({ skills: await ctx.skills.all() }));

    app.post('/api/skills', async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid skill', issues: parsed.error.issues });
      }
      const skill = await ctx.skills.create(parsed.data);
      return { skill, skills: await ctx.skills.all() };
    });

    app.patch('/api/skills/:id', async (req, reply) => {
      const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
      const parsed = patchBody.safeParse(req.body ?? {});
      if (!params.success || !parsed.success) {
        return reply.code(400).send({ error: 'Invalid skill update' });
      }
      const skill = await ctx.skills.update(params.data.id, parsed.data);
      if (!skill) return reply.code(404).send({ error: 'No such skill' });
      return { skill, skills: await ctx.skills.all() };
    });

    app.delete('/api/skills/:id', async (req, reply) => {
      const params = z.object({ id: z.string().min(1) }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'Invalid id' });

      const removed = await ctx.skills.remove(params.data.id);
      if (!removed) return reply.code(404).send({ error: 'No such skill' });
      return { skills: await ctx.skills.all() };
    });
  };
