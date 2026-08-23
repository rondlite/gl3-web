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
    const res = await appWithSite().request('http://test/api/plugins');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
  });

  it('leaves healthz alone', async () => {
    // Same reasoning as the plugins case above, covering the other route that
    // the single static-serving registration sits after.
    const res = await appWithSite().request('http://test/healthz');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('404s an unknown page rather than serving the index', async () => {
    const res = await appWithSite().request('http://test/nope.html');

    expect(res.status).toBe(404);
  });
});
