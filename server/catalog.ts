import { z } from 'zod';

import type { Logger } from './log.js';

/** What the plugins page renders. Deliberately narrower than store-api's shape. */
export type Plugin = {
  name: string;
  paid: boolean;
  version: string;
  description: string | null;
  keywords: string[];
  license: string | null;
  install: string;
};

export type CatalogResult = {
  /** False when no copy could be obtained and none was cached. */
  available: boolean;
  plugins: Plugin[];
};

export type CatalogFetch = () => Promise<unknown>;

/**
 * store-api's catalogue shape. Parsed rather than cast: this crosses a service
 * boundary, and a response we cannot understand should degrade to "unavailable"
 * rather than throw somewhere further in.
 *
 * `position`, `fetchedAt` and `stale` are deliberately not read here. They are
 * operational details of store-api's own cache and the page has no use for them.
 */
const responseSchema = z.object({
  packages: z.array(
    z.object({
      package: z.string(),
      paid: z.boolean(),
      version: z.string().nullable(),
      description: z.string().nullable(),
      keywords: z.array(z.string()).default([]),
      license: z.string().nullable(),
    })
  ),
});

function toPlugins(body: unknown): Plugin[] {
  const parsed = responseSchema.parse(body);

  return parsed.packages
    // A package whose metadata never arrived has a null version. A card with no
    // version and no description reads as broken rather than pending, so it is
    // better not to render one.
    .filter((pkg): pkg is typeof pkg & { version: string } => pkg.version !== null)
    .map((pkg) => ({
      name: pkg.package,
      paid: pkg.paid,
      version: pkg.version,
      description: pkg.description,
      keywords: pkg.keywords,
      license: pkg.license,
      install: `npm install ${pkg.package}`,
    }));
}

// How long a cold-cache failure is remembered before the next call is allowed
// to retry store-api. Short on purpose: this only exists to stop an outage
// from mapping every visitor request onto its own upstream attempt, not to
// hide a real recovery for long.
const NEGATIVE_CACHE_MS = 5_000;

/**
 * Fetches the catalogue from store-api and caches it in memory.
 *
 * The fetch is a parameter rather than an import so tests drive it without a
 * network, and so the cache has no opinion about how the data arrives.
 */
export function createCatalog(deps: {
  fetchCatalog: CatalogFetch;
  cacheMs: number;
  logger: Logger;
  now?: () => number;
}): { get: () => Promise<CatalogResult> } {
  const now = deps.now ?? (() => Date.now());

  let cached: Plugin[] | null = null;
  let cachedAt = 0;
  // Set only on a cold-cache failure, and only read when the cache is still
  // cold. Lets a failed refresh be remembered for NEGATIVE_CACHE_MS instead
  // of every request retrying store-api for the whole outage.
  let failedAt: number | null = null;
  // Holds the one in-flight refresh so concurrent callers on a miss await the
  // same upstream call instead of each starting their own. `refresh` never
  // rejects, it always resolves to a CatalogResult, so this can never be left
  // permanently pending by an unhandled rejection.
  let pending: Promise<CatalogResult> | null = null;

  async function refresh(): Promise<CatalogResult> {
    try {
      const plugins = toPlugins(await deps.fetchCatalog());
      cached = plugins;
      cachedAt = now();
      failedAt = null;
      return { available: true, plugins: [...plugins] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (cached !== null) {
        // Last known good. A stale list is always better than an empty page.
        deps.logger.warn('catalogue refresh failed, serving cache', { err: message });
        return { available: true, plugins: [...cached] };
      }

      // Cold cache. The page renders and says so rather than showing an empty
      // grid, which would read as "there are no plugins". Remember the
      // failure so the next calls serve this outcome from memory instead of
      // reattempting store-api on every single request during an outage.
      deps.logger.error('catalogue unavailable and nothing cached', { err: message });
      failedAt = now();
      return { available: false, plugins: [] };
    }
  }

  return {
    async get(): Promise<CatalogResult> {
      if (cached !== null && now() - cachedAt < deps.cacheMs) {
        return { available: true, plugins: [...cached] };
      }

      if (cached === null && failedAt !== null && now() - failedAt < NEGATIVE_CACHE_MS) {
        return { available: false, plugins: [] };
      }

      // Coalesce: the first caller past the checks above starts the refresh
      // and every other caller that arrives before it settles awaits the
      // same promise rather than opening its own upstream call.
      if (pending === null) {
        pending = refresh().finally(() => {
          pending = null;
        });
      }

      return pending;
    },
  };
}

/** The real store-api client. */
export function createStoreApiFetch(config: {
  url: string;
  key: string;
  timeoutMs: number;
}): CatalogFetch {
  return async () => {
    const response = await fetch(`${config.url}/v1/catalog/packages`, {
      headers: { authorization: `Bearer ${config.key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      // Throwing rather than returning an empty result keeps "store-api said no"
      // distinguishable from "store-api has no packages", which the caller needs
      // in order to decide whether to serve its cache.
      throw new Error(`store-api responded ${response.status}`);
    }

    return response.json();
  };
}
