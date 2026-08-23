import { describe, expect, it } from 'vitest';

import { loadEnv } from '../env.js';

const BASE = {
  STORE_API_URL: 'http://store-api:8080',
  INTERNAL_API_KEY: 'k'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults for the optional settings', () => {
    const env = loadEnv(BASE);
    expect(env.PORT).toBe(8080);
    expect(env.CATALOG_CACHE_MS).toBe(60_000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('strips a trailing slash from the store api url', () => {
    // The client joins with '/', so a trailing slash would produce '//v1/...'.
    const env = loadEnv({ ...BASE, STORE_API_URL: 'http://store-api:8080/' });
    expect(env.STORE_API_URL).toBe('http://store-api:8080');
  });

  it('refuses to start without a store api url', () => {
    // Unlike store-api's optional registry settings, a site with no catalogue
    // source has a permanently broken page. Failing at boot is louder.
    const { STORE_API_URL: _omitted, ...withoutUrl } = BASE;
    expect(() => loadEnv(withoutUrl)).toThrow(/STORE_API_URL/);
  });

  it('refuses to start without an internal api key', () => {
    const { INTERNAL_API_KEY: _omitted, ...withoutKey } = BASE;
    expect(() => loadEnv(withoutKey)).toThrow(/INTERNAL_API_KEY/);
  });

  it('rejects an internal api key that is too short to be a secret', () => {
    expect(() => loadEnv({ ...BASE, INTERNAL_API_KEY: 'short' })).toThrow(
      /INTERNAL_API_KEY/
    );
  });
});
