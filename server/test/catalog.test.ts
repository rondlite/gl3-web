import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createCatalog, createStoreApiFetch } from '../catalog.js';
import { silentLogger } from '../log.js';

// Named rather than reached for by index: `noUncheckedIndexedAccess` is on, so
// `RESPONSE.packages[0]` is possibly undefined and cannot be spread.
const PAID = {
  package: '@gl3-plugins/plugin-a',
  paid: true,
  position: 10,
  version: '1.0.0' as string | null,
  description: 'a paid plugin' as string | null,
  keywords: ['gl3'],
  license: 'UNLICENSED' as string | null,
  fetchedAt: '2026-08-24T00:00:00.000Z',
  stale: false,
};

const FREE = {
  package: '@gl3/plugin-sdk',
  paid: false,
  position: 1,
  version: '0.2.3' as string | null,
  description: 'the SDK' as string | null,
  keywords: [] as string[],
  license: 'MIT' as string | null,
  fetchedAt: '2026-08-24T00:00:00.000Z',
  stale: false,
};

const RESPONSE = { packages: [PAID, FREE] };

function pkg(overrides: Record<string, unknown> = {}) {
  return {
    package: '@gl3-plugins/fixer',
    paid: true,
    version: '0.1.9',
    description: 'a plugin',
    keywords: [],
    license: 'MIT',
    ...overrides,
  };
}

function catalogWith(fetchCatalog: () => Promise<unknown>, cacheMs = 60_000, now?: () => number) {
  return createCatalog({
    fetchCatalog,
    fetchDetail: async () => null,
    cacheMs,
    logger: silentLogger(),
    ...(now === undefined ? {} : { now }),
  });
}

describe('createCatalog', () => {
  it('trims the store-api shape to what the page needs', async () => {
    const catalog = catalogWith(async () => RESPONSE);

    expect(await catalog.get()).toEqual({
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
        {
          name: '@gl3/plugin-sdk',
          paid: false,
          version: '0.2.3',
          description: 'the SDK',
          descriptionHtml: 'the SDK',
          keywords: [],
          license: 'MIT',
          install: 'npm install @gl3/plugin-sdk',
          href: '/plugins/gl3/plugin-sdk.html',
        },
      ],
    });
  });

  it('drops a package whose metadata never arrived', async () => {
    // A card with a null version and no description reads as broken rather
    // than pending, so it is better not to render one at all.
    const catalog = catalogWith(async () => ({
      packages: [{ ...PAID, version: null, description: null }, FREE],
    }));

    const result = await catalog.get();
    expect(result.plugins.map((p) => p.name)).toEqual(['@gl3/plugin-sdk']);
    expect(result.available).toBe(true);
  });

  it('serves the last good copy when store-api fails', async () => {
    let calls = 0;
    const catalog = catalogWith(async () => {
      calls += 1;
      if (calls === 1) {
        return RESPONSE;
      }
      throw new Error('connect ECONNREFUSED');
    }, 0);

    const first = await catalog.get();
    expect(first.plugins).toHaveLength(2);

    const second = await catalog.get();
    expect(second.available).toBe(true);
    expect(second.plugins).toHaveLength(2);
  });

  it('returns an empty list with available false on a cold cache', async () => {
    // 200 rather than an error: the plugins page is one section of a working
    // website, and a backend blip must degrade the section, not the page.
    const catalog = catalogWith(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    expect(await catalog.get()).toEqual({ available: false, plugins: [] });
  });

  it('treats an unrecognisable response as unavailable rather than crashing', async () => {
    const catalog = catalogWith(async () => ({ nonsense: true }));

    expect(await catalog.get()).toEqual({ available: false, plugins: [] });
  });

  it('calls store-api once inside the cache window', async () => {
    let calls = 0;
    const catalog = catalogWith(async () => {
      calls += 1;
      return RESPONSE;
    });

    await catalog.get();
    await catalog.get();
    await catalog.get();

    expect(calls).toBe(1);
  });

  it('calls store-api again once the cache expires', async () => {
    let calls = 0;
    let clock = 1000;
    const catalog = catalogWith(
      async () => {
        calls += 1;
        return RESPONSE;
      },
      60_000,
      () => clock
    );

    await catalog.get();
    clock += 59_000;
    await catalog.get();
    expect(calls).toBe(1);

    clock += 2_000;
    await catalog.get();
    expect(calls).toBe(2);
  });

  it('returns the cached plugins on a cache hit', async () => {
    const catalog = catalogWith(async () => RESPONSE);

    const first = await catalog.get();
    expect(first).toEqual({
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
        {
          name: '@gl3/plugin-sdk',
          paid: false,
          version: '0.2.3',
          description: 'the SDK',
          descriptionHtml: 'the SDK',
          keywords: [],
          license: 'MIT',
          install: 'npm install @gl3/plugin-sdk',
          href: '/plugins/gl3/plugin-sdk.html',
        },
      ],
    });

    const second = await catalog.get();
    expect(second).toEqual(first);
  });

  it('coalesces concurrent calls on a cold cache into a single upstream fetch', async () => {
    // /api/plugins is public and unauthenticated; store-api is not. Ten
    // callers arriving before the first refresh settles must produce one
    // upstream call, not ten.
    let calls = 0;
    const catalog = catalogWith(async () => {
      calls += 1;
      return RESPONSE;
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => catalog.get()));

    expect(calls).toBe(1);
    for (const result of results) {
      expect(result.plugins).toHaveLength(2);
    }
  });

  it('serves a cached failure during the negative-cache window instead of retrying every call', async () => {
    let calls = 0;
    let clock = 1_000;
    const catalog = catalogWith(
      async () => {
        calls += 1;
        throw new Error('connect ECONNREFUSED');
      },
      60_000,
      () => clock
    );

    const first = await catalog.get();
    expect(first).toEqual({ available: false, plugins: [] });
    expect(calls).toBe(1);

    // Still inside the negative-cache window: served from memory, no retry.
    clock += 1_000;
    await catalog.get();
    await catalog.get();
    expect(calls).toBe(1);

    // Window elapsed: the next call is allowed to try store-api again.
    clock += 5_000;
    await catalog.get();
    expect(calls).toBe(2);
  });

  it('does not expose the cached array to mutation', async () => {
    const catalog = catalogWith(async () => RESPONSE);

    const first = await catalog.get();
    expect(first.plugins).toHaveLength(2);
    first.plugins.push({
      name: 'mutated',
      paid: false,
      version: '1.0.0',
      description: null,
      descriptionHtml: null,
      keywords: [],
      license: null,
      install: 'npm install mutated',
      href: '/plugins/mutated.html',
    });

    const second = await catalog.get();
    expect(second.plugins).toHaveLength(2);
  });
});

describe('descriptions', () => {
  it('renders markdown in the description', async () => {
    const catalog = createCatalog({
      fetchCatalog: async () => ({
        packages: [pkg({ description: '**bold** pitch' })],
      }),
      fetchDetail: async () => null,
      cacheMs: 1000,
      logger: silentLogger(),
    });

    const result = await catalog.get();
    expect(result.plugins[0]?.descriptionHtml).toBe('<strong>bold</strong> pitch');
  });

  it('keeps the plain description, which the page meta tag needs', async () => {
    const catalog = createCatalog({
      fetchCatalog: async () => ({ packages: [pkg({ description: '**bold**' })] }),
      fetchDetail: async () => null,
      cacheMs: 1000,
      logger: silentLogger(),
    });

    expect((await catalog.get()).plugins[0]?.description).toBe('**bold**');
  });

  it('gives each plugin a page link with the scope as its own segment', async () => {
    const catalog = createCatalog({
      fetchCatalog: async () => ({ packages: [pkg({ package: '@gl3-plugins/fixer' })] }),
      fetchDetail: async () => null,
      cacheMs: 1000,
      logger: silentLogger(),
    });

    expect((await catalog.get()).plugins[0]?.href).toBe('/plugins/gl3-plugins/fixer.html');
  });
});

describe('getDetail', () => {
  it('renders the readme', async () => {
    const catalog = createCatalog({
      fetchCatalog: async () => ({ packages: [pkg({ package: '@gl3/plugin-sdk' })] }),
      fetchDetail: async () => ({ ...pkg({ package: '@gl3/plugin-sdk' }), readme: '# Title' }),
      cacheMs: 1000,
      logger: silentLogger(),
    });

    const result = await catalog.getDetail('@gl3/plugin-sdk');
    expect(result.plugin?.readmeHtml).toContain('<h1');
  });

  it('reports an uncatalogued package as missing without calling store-api', async () => {
    let detailCalls = 0;
    const catalog = createCatalog({
      fetchCatalog: async () => ({ packages: [pkg({ package: '@gl3/plugin-sdk' })] }),
      fetchDetail: async () => {
        detailCalls += 1;
        return null;
      },
      cacheMs: 1000,
      logger: silentLogger(),
    });

    const result = await catalog.getDetail('@gl3/not-listed');

    // available:true and plugin:null is "we asked and it is not in the
    // catalogue", which the route turns into a 404. Not calling store-api at
    // all also stops an attacker growing the detail cache with junk names.
    expect(result).toEqual({ available: true, plugin: null });
    expect(detailCalls).toBe(0);
  });

  it('serves the last known good readme when a later fetch fails', async () => {
    let attempt = 0;
    const catalog = createCatalog({
      fetchCatalog: async () => ({ packages: [pkg({ package: '@gl3/plugin-sdk' })] }),
      fetchDetail: async () => {
        attempt += 1;
        if (attempt === 1) {
          return { ...pkg({ package: '@gl3/plugin-sdk' }), readme: 'first' };
        }
        throw new Error('upstream down');
      },
      cacheMs: 0,
      logger: silentLogger(),
    });

    await catalog.getDetail('@gl3/plugin-sdk');
    const second = await catalog.getDetail('@gl3/plugin-sdk');

    expect(second.available).toBe(true);
    expect(second.plugin?.readmeHtml).toContain('first');
  });

  it('makes one upstream call when concurrent requests miss the cache', async () => {
    let calls = 0;
    const catalog = createCatalog({
      fetchCatalog: async () => ({ packages: [pkg({ package: '@gl3/plugin-sdk' })] }),
      fetchDetail: async () => {
        calls += 1;
        return { ...pkg({ package: '@gl3/plugin-sdk' }), readme: 'x' };
      },
      cacheMs: 1000,
      logger: silentLogger(),
    });

    await Promise.all([
      catalog.getDetail('@gl3/plugin-sdk'),
      catalog.getDetail('@gl3/plugin-sdk'),
    ]);

    expect(calls).toBe(1);
  });

  it('reports unavailable when the catalogue itself cannot be reached', async () => {
    const catalog = createCatalog({
      fetchCatalog: async () => {
        throw new Error('down');
      },
      fetchDetail: async () => null,
      cacheMs: 1000,
      logger: silentLogger(),
    });

    expect(await catalog.getDetail('@gl3/plugin-sdk')).toEqual({
      available: false,
      plugin: null,
    });
  });
});

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
});

describe('createStoreApiFetch', () => {
  it('sends the internal key as a bearer token and returns the body', async () => {
    let seenAuth: string | undefined;
    let seenUrl: string | undefined;

    server = createServer((req, res) => {
      seenAuth = req.headers.authorization;
      seenUrl = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(RESPONSE));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server!.address() as { port: number }).port;

    const fetchCatalog = createStoreApiFetch({
      url: `http://127.0.0.1:${port}`,
      key: 'k'.repeat(32),
      timeoutMs: 5000,
    });

    expect(await fetchCatalog()).toEqual(RESPONSE);
    expect(seenAuth).toBe(`Bearer ${'k'.repeat(32)}`);
    expect(seenUrl).toBe('/v1/catalog/packages');
  });

  it('throws on a non-2xx so the caller can fall back to cache', async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server!.address() as { port: number }).port;

    const fetchCatalog = createStoreApiFetch({
      url: `http://127.0.0.1:${port}`,
      key: 'k'.repeat(32),
      timeoutMs: 5000,
    });

    await expect(fetchCatalog()).rejects.toThrow(/401/);
  });
});
