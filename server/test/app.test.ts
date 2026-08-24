import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import type { CatalogResult, Plugin, PluginDetail } from '../catalog.js';

const READY: CatalogResult = {
  available: true,
  plugins: [
    {
      name: '@gl3-plugins/plugin-a',
      paid: true,
      version: '1.0.0',
      description: 'a paid plugin',
      descriptionHtml: 'a paid plugin',
      keywords: ['gl3'],
      license: 'UNLICENSED',
      install: 'npm install @gl3-plugins/plugin-a',
      href: '/plugins/gl3-plugins/plugin-a.html',
    },
  ],
};

function appWith(result: CatalogResult | (() => Promise<CatalogResult>)) {
  const get = typeof result === 'function' ? result : async () => result;
  // Never exercised by these tests, which only hit /api/plugins and /healthz.
  const getDetail = async () => ({ available: true, plugin: null });
  return createApp({ catalog: { get, getDetail } });
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
        getDetail: async () => ({ available: true, plugin: null }),
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

describe('the plugin page route', () => {
  it('serves the page for a catalogued plugin', async () => {
    const app = createApp({
      catalog: {
        get: async () => ({ available: true, plugins: [] }),
        getDetail: async () => ({ available: true, plugin: detail() }),
      },
      stylesheets: [],
      origin: 'https://gl3.dev',
    });

    const response = await app.request('/plugins/gl3-plugins/fixer.html');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<h1>Fixer</h1>');
  });

  it('rebuilds the scoped package name from the two path segments', async () => {
    let asked = '';
    const app = createApp({
      catalog: {
        get: async () => ({ available: true, plugins: [] }),
        getDetail: async (name: string) => {
          asked = name;
          return { available: true, plugin: detail() };
        },
      },
      stylesheets: [],
      origin: 'https://gl3.dev',
    });

    await app.request('/plugins/gl3/plugin-sdk.html');

    expect(asked).toBe('@gl3/plugin-sdk');
  });

  it('404s an uncatalogued plugin', async () => {
    const app = createApp({
      catalog: {
        get: async () => ({ available: true, plugins: [] }),
        getDetail: async () => ({ available: true, plugin: null }),
      },
      stylesheets: [],
      origin: 'https://gl3.dev',
    });

    expect((await app.request('/plugins/gl3/nope.html')).status).toBe(404);
  });

  it('404s a scope that is not ours, without calling store-api', async () => {
    let calls = 0;
    const app = createApp({
      catalog: {
        get: async () => ({ available: true, plugins: [] }),
        getDetail: async () => {
          calls += 1;
          return { available: true, plugin: null };
        },
      },
      stylesheets: [],
      origin: 'https://gl3.dev',
    });

    expect((await app.request('/plugins/evil/x.html')).status).toBe(404);
    expect(calls).toBe(0);
  });

  it('503s when the catalogue is unreachable, so a crawler comes back', async () => {
    const app = createApp({
      catalog: {
        get: async () => ({ available: false, plugins: [] }),
        getDetail: async () => ({ available: false, plugin: null }),
      },
      stylesheets: [],
      origin: 'https://gl3.dev',
    });

    expect((await app.request('/plugins/gl3/plugin-sdk.html')).status).toBe(503);
  });
});

describe('the sitemap', () => {
  it('lists every catalogued plugin', async () => {
    const app = createApp({
      catalog: {
        get: async () => ({ available: true, plugins: [listed()] }),
        getDetail: async () => ({ available: true, plugin: null }),
      },
      stylesheets: [],
      origin: 'https://gl3.dev',
    });

    const response = await app.request('/sitemap.xml');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('xml');
    expect(await response.text()).toContain('/plugins/gl3-plugins/fixer.html');
  });
});

it('resolves the plugin page route ahead of the static handler', async () => {
  // The static handler calls next() when no file matches, so a route registered
  // after it can still answer. This asserts the opposite direction: a file that
  // happens to sit at the same path must not shadow the route.
  const app = createApp({
    catalog: {
      get: async () => ({ available: true, plugins: [] }),
      getDetail: async () => ({ available: true, plugin: detail() }),
    },
    stylesheets: [],
    origin: 'https://gl3.dev',
    siteDist: './server/test/fixtures/site',
  });

  const response = await app.request('/plugins/gl3-plugins/fixer.html');

  expect(await response.text()).toContain('<h1>Fixer</h1>');
});

function listed(): Plugin {
  return {
    name: '@gl3-plugins/fixer',
    paid: true,
    version: '0.1.9',
    description: 'An AI contract broker',
    descriptionHtml: 'An AI contract broker',
    keywords: [],
    license: 'MIT',
    install: 'npm install @gl3-plugins/fixer',
    href: '/plugins/gl3-plugins/fixer.html',
  };
}

function detail(): PluginDetail {
  return { ...listed(), readmeHtml: '<h1>Fixer</h1>' };
}
