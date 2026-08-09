import { buildApp } from './app.js';
import { createContext } from './context.js';
import { env } from './env.js';
import { logger } from './logger.js';

async function main(): Promise<void> {
  const ctx = await createContext();
  const app = await buildApp(ctx);

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT, dataDir: env.DATA_DIR }, 'srevoice is listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Stop accepting requests before tearing down MCP sessions, so an
    // in-flight tool call is not cut off mid-conversation.
    const timer = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    timer.unref();

    try {
      await app.close();
      await ctx.pool.shutdown();
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'Unhandled rejection');
  });
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'Failed to start srevoice');
  process.exit(1);
});
