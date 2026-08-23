import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import type { CatalogResult } from '../catalog.js';

const READY: CatalogResult = {
  available: true,
  plugins: [
    {
      name: '@gl3-plugins/plugin-a',
      paid: true,
      version: '1.0.0',
      description: 'a paid plugin',
      keywords: ['gl3'],
      license: 'UNLICENSED',
      install: 'npm install @gl3-plugins/plugin-a',
    },
  ],
};

function appWith(result: CatalogResult | (() => Promise<CatalogResult>)) {
  const get = typeof result === 'function' ? result : async () => result;
  return createApp({ catalog: { get } });
}

describe('GET /api/plugins', () => {
  it('returns the catalogue', async () => {
    const res = await appWith(READY).request('http://test/api/plugins');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(READY);
  });

  it('returns 200 with available false when the catalogue is unavailable', async () => {
    const res = await appWith({ available: false, plugins: [] }).request(
      'http://test/api/plugins'
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, plugins: [] });
  });

  it('never throws, even when the catalogue itself throws', async () => {
    const res = await appWith(async () => {
      throw new Error('boom');
    }).request('http://test/api/plugins');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, plugins: [] });
  });

  it('never leaks the internal api key', async () => {
    // The whole reason a server exists here is to hold that key. If it appears
    // in a response body, the static site could have done this job.
    const key = 'super-secret-internal-key-0123456789';
    const app = createApp({
      catalog: {
        get: async () => {
          throw new Error(`request failed with ${key}`);
        },
      },
    });

    const res = await app.request('http://test/api/plugins');
    expect(await res.text()).not.toContain(key);
  });
});

describe('GET /healthz', () => {
  it('reports ok', async () => {
    const res = await appWith(READY).request('http://test/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
