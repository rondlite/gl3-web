import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './log.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const app = createApp({ logger });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('listening', { port: info.port });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
