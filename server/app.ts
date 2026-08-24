import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CatalogResult, DetailResult } from './catalog.js';
import { type Logger, silentLogger } from './log.js';
import { renderPluginPage, renderSitemap } from './plugin-page.js';

export type AppDeps = {
  catalog: {
    get: () => Promise<CatalogResult>;
    getDetail: (packageName: string) => Promise<DetailResult>;
  };
  logger?: Logger;
  /** Directory holding the VitePress build output. */
  siteDist?: string;
  /** Built stylesheet paths, discovered at startup. */
  stylesheets?: string[];
  /** Absolute base URL, for canonical links and the sitemap. */
  origin?: string;
};

export function createApp({
  catalog,
  logger = silentLogger(),
  siteDist = './site/.vitepress/dist',
  stylesheets = [],
  origin = 'https://gl3.dev',
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

  // Only our own scopes. Rejecting anything else here means an invented URL
  // never reaches store-api.
  const SCOPES = new Set(['gl3', 'gl3-plugins']);

  app.get('/plugins/:scope/:file', async (c, next) => {
    const scope = c.req.param('scope');
    const file = c.req.param('file');

    if (!SCOPES.has(scope) || !file.endsWith('.html')) {
      // next() rather than a 404 here, so a real file at this path is still
      // served and the notFound handler produces the styled page.
      return next();
    }

    const packageName = `@${scope}/${file.slice(0, -'.html'.length)}`;
    const result = await catalog.getDetail(packageName);

    if (!result.available) {
      // 503 rather than 404: an outage must not be recorded by a crawler as a
      // permanent absence.
      return c.text('The plugin catalogue is not reachable right now.', 503);
    }

    if (result.plugin === null) {
      return next();
    }

    return c.html(renderPluginPage({ plugin: result.plugin, stylesheets, origin }));
  });

  app.get('/sitemap.xml', async (c) => {
    const { available, plugins } = await catalog.get();

    if (!available) {
      // 503 rather than a sitemap missing every plugin: the same reasoning as
      // the detail route above. No sitemap during an outage is recoverable; a
      // sitemap that drops every plugin URL reads to a crawler as mass removal.
      return c.text('The plugin catalogue is not reachable right now.', 503);
    }

    return c.text(renderSitemap({ plugins, origin }), 200, {
      'content-type': 'application/xml; charset=UTF-8',
    });
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
