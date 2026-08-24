import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createCatalog, createStoreApiDetailFetch, createStoreApiFetch } from './catalog.js';
import { loadEnv } from './env.js';
import { createLogger } from './log.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const catalog = createCatalog({
  fetchCatalog: createStoreApiFetch({
    url: env.STORE_API_URL,
    key: env.INTERNAL_API_KEY,
    timeoutMs: 5000,
  }),
  fetchDetail: createStoreApiDetailFetch({
    url: env.STORE_API_URL,
    key: env.INTERNAL_API_KEY,
    timeoutMs: 5000,
  }),
  cacheMs: env.CATALOG_CACHE_MS,
  logger,
});

const app = createApp({ catalog, logger, siteDist: env.SITE_DIST });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('listening', { port: info.port });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
