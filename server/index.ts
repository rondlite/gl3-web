import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createCatalog, createStoreApiDetailFetch, createStoreApiFetch } from './catalog.js';
import { loadEnv } from './env.js';
import { createLogger } from './log.js';
import { discoverStylesheets } from './plugin-page.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const stylesheets = await discoverStylesheets(env.SITE_DIST);

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

const app = createApp({
  storefront: { url: env.STORE_API_URL, key: env.INTERNAL_API_KEY, origin: env.PUBLIC_ORIGIN },
  catalog,
  logger,
  siteDist: env.SITE_DIST,
  stylesheets,
  origin: env.PUBLIC_ORIGIN,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('listening', { port: info.port });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
