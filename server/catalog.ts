import { z } from 'zod';

import { renderBlock, renderInline } from './markdown.js';
import type { Logger } from './log.js';

/** What the plugins page renders. Deliberately narrower than store-api's shape. */
export type Plugin = {
  name: string;
  paid: boolean;
  version: string;
  description: string | null;
  /** The description as sanitised HTML. What the card renders. */
  descriptionHtml: string | null;
  keywords: string[];
  license: string | null;
  install: string;
  /** Link to this plugin's page. */
  href: string;
};

export type PluginDetail = Plugin & { readmeHtml: string | null };

/**
 * The scopes the site serves a page for.
 *
 * Exported because the route needs the same list: it is what stops an invented
 * URL reaching store-api. Held here, next to pluginHref, so the two cannot
 * drift apart and start disagreeing about which URLs exist.
 */
export const PLUGIN_SCOPES = ['gl3', 'gl3-plugins'] as const;

const scopes: ReadonlySet<string> = new Set(PLUGIN_SCOPES);

/**
 * Builds a plugin's page URL, or null for a package the site cannot address.
 *
 * The scope keeps its own path segment with the "@" dropped, rather than being
 * flattened into the name with a hyphen. Flattening collides: "@gl3-plugins/fixer"
 * and "@gl3/plugins-fixer" would both become "gl3-plugins-fixer", and both
 * scopes are real in this catalogue. Two segments cannot.
 *
 * Null rather than a best-effort URL for an unscoped name or an unknown scope.
 * Every href this returns is advertised to crawlers in the sitemap and rendered
 * as a card link, so a URL the route would 404 is worse than no card at all.
 */
export function pluginHref(packageName: string): string | null {
  const [scope, name] = packageName.replace(/^@/, '').split('/');
  if (scope === undefined || name === undefined || !scopes.has(scope)) {
    return null;
  }
  return `/plugins/${scope}/${name}.html`;
}

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

function toPlugins(body: unknown, logger: Logger): Plugin[] {
  const parsed = responseSchema.parse(body);

  const plugins: Plugin[] = [];

  for (const pkg of parsed.packages) {
    // A package whose metadata never arrived has a null version. A card with no
    // version and no description reads as broken rather than pending, so it is
    // better not to render one.
    if (pkg.version === null) {
      continue;
    }

    const href = pluginHref(pkg.package);
    if (href === null) {
      // A scope the route does not serve. Dropping it keeps the grid and the
      // sitemap free of URLs that 404, and the warning is how anyone finds out
      // a new scope needs adding to PLUGIN_SCOPES.
      logger.warn('package skipped, no page can be addressed for it', { package: pkg.package });
      continue;
    }

    plugins.push({
      name: pkg.package,
      paid: pkg.paid,
      version: pkg.version,
      description: pkg.description,
      descriptionHtml: renderInline(pkg.description),
      keywords: pkg.keywords,
      license: pkg.license,
      install: `npm install ${pkg.package}`,
      href,
    });
  }

  return plugins;
}

/**
 * store-api's package detail shape. Parsed separately from the list schema
 * because the detail endpoint also carries the readme, which the list
 * endpoint deliberately omits.
 */
const detailSchema = z.object({
  package: z.string(),
  paid: z.boolean(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  keywords: z.array(z.string()).default([]),
  license: z.string().nullable(),
  readme: z.string().nullable().default(null),
});

export type DetailFetch = (packageName: string) => Promise<unknown>;

export type DetailResult = {
  /**
   * False only when the catalogue list itself is unreachable and nothing was
   * cached, which is the case the route answers with 503. A package whose
   * readme could not be fetched is still available: its page renders from list
   * metadata with a note in place of the readme.
   */
  available: boolean;
  /** Null when the package is not in the catalogue. */
  plugin: PluginDetail | null;
};

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
  fetchDetail: DetailFetch;
  cacheMs: number;
  logger: Logger;
  now?: () => number;
}): { get: () => Promise<CatalogResult>; getDetail: (packageName: string) => Promise<DetailResult> } {
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

  // Keyed by package name. Bounded by the catalogue, because getDetail refuses
  // to fetch a name the list does not contain, so a stream of invented URLs
  // cannot grow this map.
  const details = new Map<string, { plugin: PluginDetail; at: number }>();
  const detailPending = new Map<string, Promise<DetailResult>>();
  // The detail path's negative cache, keyed the same way. Without it a crawler
  // walking the sitemap during an outage opens one upstream call per plugin per
  // pass, each waiting out the timeout, even though every one of those requests
  // can already be answered from list metadata.
  const detailFailedAt = new Map<string, number>();

  function toDetail(list: Plugin, body: unknown): PluginDetail {
    const parsed = detailSchema.parse(body);
    return { ...list, readmeHtml: renderBlock(parsed.readme) };
  }

  async function refreshDetail(packageName: string, list: Plugin): Promise<DetailResult> {
    try {
      const body = await deps.fetchDetail(packageName);
      if (body === null) {
        // In our list but not in store-api's. A race with a removal, so treat
        // it as missing without caching a negative.
        return { available: true, plugin: null };
      }
      const plugin = toDetail(list, body);
      details.set(packageName, { plugin, at: now() });
      detailFailedAt.delete(packageName);
      return { available: true, plugin };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cachedDetail = details.get(packageName);
      detailFailedAt.set(packageName, now());

      if (cachedDetail !== undefined) {
        // Last known good, the same rule the list follows. A stale readme is
        // always better than an error page.
        deps.logger.warn('detail refresh failed, serving cache', {
          package: packageName,
          err: message,
        });
        return { available: true, plugin: cachedDetail.plugin };
      }

      // No readme, but the list entry holds the name, version, licence,
      // description and install line, which is a page worth serving. available
      // stays true because the catalogue itself is fine; false is reserved for
      // the list being unreachable, which getDetail answers before it gets
      // here.
      deps.logger.warn('detail unavailable, serving list metadata without a readme', {
        package: packageName,
        err: message,
      });
      return { available: true, plugin: { ...list, readmeHtml: null } };
    }
  }

  async function refresh(): Promise<CatalogResult> {
    try {
      const plugins = toPlugins(await deps.fetchCatalog(), deps.logger);
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

  const api = {
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

    async getDetail(packageName: string): Promise<DetailResult> {
      const listed = await api.get();
      if (!listed.available) {
        return { available: false, plugin: null };
      }

      // Membership is checked against the list before any upstream call. It
      // answers 404 for free, and it is what keeps the detail cache bounded.
      const list = listed.plugins.find((plugin) => plugin.name === packageName);
      if (list === undefined) {
        return { available: true, plugin: null };
      }

      const cachedDetail = details.get(packageName);
      if (cachedDetail !== undefined && now() - cachedDetail.at < deps.cacheMs) {
        return { available: true, plugin: cachedDetail.plugin };
      }

      const failed = detailFailedAt.get(packageName);
      if (failed !== undefined && now() - failed < NEGATIVE_CACHE_MS) {
        // A recent attempt failed, so answer from what is already here rather
        // than reattempting store-api for every request during an outage.
        return cachedDetail === undefined
          ? { available: true, plugin: { ...list, readmeHtml: null } }
          : { available: true, plugin: cachedDetail.plugin };
      }

      let inFlight = detailPending.get(packageName);
      if (inFlight === undefined) {
        inFlight = refreshDetail(packageName, list).finally(() => {
          detailPending.delete(packageName);
        });
        detailPending.set(packageName, inFlight);
      }

      return inFlight;
    },
  };

  return api;
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

/**
 * Fetches one package's detail, including its readme.
 *
 * Returns null on 404 rather than throwing, because "not catalogued" and
 * "store-api is broken" lead to different status codes on the page: a 404 the
 * crawler can trust, versus a 503 it should come back for.
 */
export function createStoreApiDetailFetch(config: {
  url: string;
  key: string;
  timeoutMs: number;
}): DetailFetch {
  return async (packageName: string) => {
    const response = await fetch(
      `${config.url}/v1/catalog/packages/${encodeURIComponent(packageName)}`,
      {
        headers: { authorization: `Bearer ${config.key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeoutMs),
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`store-api responded ${response.status}`);
    }

    return response.json();
  };
}
