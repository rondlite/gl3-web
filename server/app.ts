import { Hono } from 'hono';

import { type Logger, silentLogger } from './log.js';

export type AppDeps = {
  logger?: Logger;
};

export function createApp({ logger = silentLogger() }: AppDeps = {}) {
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

  return app;
}
