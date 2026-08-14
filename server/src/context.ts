import { env } from './env.js';
import { logger } from './logger.js';
import { McpPool } from './mcp/pool.js';
import { PendingCalls } from './mcp/pending.js';
import { MemoryStore } from './store/memory.js';
import { SettingsStore } from './store/settings.js';
import { SkillStore } from './store/skills.js';

export interface AppContext {
  store: SettingsStore;
  pool: McpPool;
  memory: MemoryStore;
  skills: SkillStore;
  pending: PendingCalls;
}

export async function createContext(): Promise<AppContext> {
  const store = new SettingsStore(env.DATA_DIR, env.SREVOICE_MASTER_KEY);
  const pool = new McpPool();
  const memory = new MemoryStore(env.DATA_DIR, env.SREVOICE_MASTER_KEY);
  const skills = new SkillStore(env.DATA_DIR, env.SREVOICE_MASTER_KEY);
  const pending = new PendingCalls();

  // Connect to whatever was configured last run so the console is usable the
  // moment the page loads, rather than after a manual reconnect.
  try {
    const settings = await store.load();
    if (settings.mcpServers.length > 0) {
      await pool.sync(settings.mcpServers);
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Failed to restore MCP connections at startup');
  }

  return { store, pool, memory, skills, pending };
}
