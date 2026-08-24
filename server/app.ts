import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CatalogResult } from './catalog.js';
import { type Logger, silentLogger } from './log.js';

export type AppDeps = {
  catalog: { get: () => Promise<CatalogResult> };
  logger?: Logger;
  /** Directory holding the VitePress build output. */
  siteDist?: string;
};

export function createApp({
  catalog,
  logger = silentLogger(),
  siteDist = './site/.vitepress/dist',
}: AppDeps) {
  const app = new Hono();

  // One line per request. Paths carry no secrets, and bodies and headers are
  // never logged.
  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    await next();
    logger.info('request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - startedAt,
    });
  });

  // Without this an unhandled throw becomes a bare 500 with nothing written
  // anywhere, leaving a caller staring at a 500 and empty logs.
  app.onError((err, c) => {
    logger.error('unhandled error', {
      method: c.req.method,
      path: c.req.path,
      err: err.message,
    });
    return c.json({ error: 'internal' }, 500);
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/api/plugins', async (c) => {
    try {
      return c.json(await catalog.get());
    } catch (err) {
      // The catalogue already handles its own failures, so reaching here means
      // something unexpected. Degrade the section rather than the page, and keep
      // the error out of the response: it can carry the upstream URL and key.
      logger.error('plugins route failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return c.json({ available: false, plugins: [] });
    }
  });

  // Registered last on purpose: Hono matches in registration order, so putting
  // this above the API routes would let a file named like a route shadow it.
  app.use('/*', serveStatic({ root: siteDist }));

  // Without this, an unmatched URL gets Hono's built-in plain-text 404 rather
  // than the styled page VitePress already built. Falls back to that plain
  // text itself if the file cannot be read, so a misconfigured SITE_DIST
  // degrades to a bare response instead of throwing out of the handler.
  app.notFound(async (c) => {
    try {
      const body = await readFile(join(siteDist, '404.html'), 'utf-8');
      return c.html(body, 404);
    } catch {
      return c.text('404 Not Found', 404);
    }
  });

  return app;
}
