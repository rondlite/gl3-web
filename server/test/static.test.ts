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
    // Static serving is registered last so it cannot shadow /api/*.
    const res = await appWithSite().request('http://test/api/plugins');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
  });

  it('404s an unknown page rather than serving the index', async () => {
    const res = await appWithSite().request('http://test/nope.html');

    expect(res.status).toBe(404);
  });
});
