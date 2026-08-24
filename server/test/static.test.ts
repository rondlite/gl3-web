import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import type { CatalogResult } from '../catalog.js';

const EMPTY: CatalogResult = { available: true, plugins: [] };

function appWithSite() {
  return createApp({
    catalog: { get: async () => EMPTY },
    siteDist: './server/test/fixtures/site',
  });
}

describe('static serving', () => {
  it('serves the built page', async () => {
    const res = await appWithSite().request('http://test/pricing.html');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('pricing');
  });

  it('serves index.html at the root', async () => {
    const res = await appWithSite().request('http://test/');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('home');
  });

  it('leaves the api routes alone', async () => {
    // The fixture directory has a real file at api/plugins, colliding with the
    // route on purpose. serveStatic falls through to next() on a miss, so a
    // fixture with no matching file cannot prove ordering: this assertion only
    // means something because there is a file here that static serving could
    // wrongly return instead of the route's JSON if it were registered first.
    //
    // Asserted on the raw body text rather than res.json(): if the fixture's
    // plain text were served instead, res.json() would throw, which fails
    // the test but not by way of a diff that says what happened. A refactor
    // that swallowed that exception would make this pass silently.
    const res = await appWithSite().request('http://test/api/plugins');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify(EMPTY));
  });

  it('leaves healthz alone', async () => {
    // Same reasoning as the plugins case above, covering the other route that
    // the single static-serving registration sits after.
    const res = await appWithSite().request('http://test/healthz');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ ok: true }));
  });

  it('serves the built 404 page for an unknown path', async () => {
    const res = await appWithSite().request('http://test/nope.html');

    expect(res.status).toBe(404);
    expect(await res.text()).toContain('gl3 404 fixture');
  });

  it('falls back to a plain 404 when the built 404 page cannot be read', async () => {
    // A misconfigured or missing SITE_DIST must not crash the not-found
    // handler; it degrades to a plain response instead.
    const app = createApp({
      catalog: { get: async () => EMPTY },
      siteDist: './server/test/fixtures/does-not-exist',
    });
    const res = await app.request('http://test/nope.html');

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('404 Not Found');
  });
});
