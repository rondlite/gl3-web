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

function catalogWith(fetchCatalog: () => Promise<unknown>, cacheMs = 60_000, now?: () => number) {
  return createCatalog({
    fetchCatalog,
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
          keywords: ['gl3'],
          license: 'UNLICENSED',
          install: 'npm install @gl3-plugins/plugin-a',
        },
        {
          name: '@gl3/plugin-sdk',
          paid: false,
          version: '0.2.3',
          description: 'the SDK',
          keywords: [],
          license: 'MIT',
          install: 'npm install @gl3/plugin-sdk',
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
          keywords: ['gl3'],
          license: 'UNLICENSED',
          install: 'npm install @gl3-plugins/plugin-a',
        },
        {
          name: '@gl3/plugin-sdk',
          paid: false,
          version: '0.2.3',
          description: 'the SDK',
          keywords: [],
          license: 'MIT',
          install: 'npm install @gl3/plugin-sdk',
        },
      ],
    });

    const second = await catalog.get();
    expect(second).toEqual(first);
  });

  it('does not expose the cached array to mutation', async () => {
    const catalog = catalogWith(async () => RESPONSE);

    const first = await catalog.get();
    expect(first.plugins).toHaveLength(2);
    first.plugins.push({ name: 'mutated', paid: false, version: '1.0.0', description: null, keywords: [], license: null, install: 'npm install mutated' });

    const second = await catalog.get();
    expect(second.plugins).toHaveLength(2);
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
