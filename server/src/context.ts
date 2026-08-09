import { env } from './env.js';
import { logger } from './logger.js';
import { McpPool } from './mcp/pool.js';
import { SettingsStore } from './store/settings.js';

export interface AppContext {
  store: SettingsStore;
  pool: McpPool;
}

export async function createContext(): Promise<AppContext> {
  const store = new SettingsStore(env.DATA_DIR, env.SREVOICE_MASTER_KEY);
  const pool = new McpPool();

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

  return { store, pool };
}
