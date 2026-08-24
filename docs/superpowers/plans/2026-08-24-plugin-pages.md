# Plugin cards and plugin pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render package markdown safely on the server, so plugin cards show formatted descriptions and every plugin gets a prerendered page at a real URL.

**Architecture:** All markdown becomes HTML inside the Hono server, using `marked` to parse and `sanitize-html` to sanitise, because the site is built in GitHub Actions where store-api is unreachable. Detail pages are standalone documents rendered per request from the catalogue cache, linking the built stylesheet so they match the site's palette without running VitePress and fighting Vue hydration.

**Tech Stack:** Node 22, TypeScript strict, Hono 4.7, zod 3.24, Vitest 3.1, VitePress 1.6, marked 18, sanitize-html 2.17.

**Spec:** `docs/superpowers/specs/2026-08-24-plugin-pages-design.md`

## Global Constraints

- **No em dashes** in any prose: code comments, commit messages, spec text, and every string that reaches a page. Restructure the sentence instead.
- **Sanitise on every path that turns package data into HTML.** There is no trusted-publisher branch.
- Imports between local modules carry the `.js` suffix, matching the existing ESM setup.
- Dependencies are pinned to exact versions, matching the existing `package.json` style (no `^`, no `~`).
- Dependencies are injected as parameters rather than imported into the units that use them, matching `createCatalog` and `createApp`.
- The static file handler in `server/app.ts` stays registered **last**. Every new route goes above it.
- `npm run typecheck` and `npm test` must pass before each commit.
- Test names describe behaviour, not implementation.

---

### Task 1: The markdown module

The one place markdown becomes HTML. Pure, server-side, no DOM.

**Files:**
- Modify: `package.json`
- Create: `server/markdown.ts`
- Test: `server/test/markdown.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `renderInline(src: string | null): string | null`
  - `renderBlock(src: string | null): string | null`

- [ ] **Step 1: Add the dependencies**

```bash
npm install --save-exact marked@18.0.11 sanitize-html@2.17.7
npm install --save-exact --save-dev @types/sanitize-html@2.16.1
```

- [ ] **Step 2: Write the failing tests**

Create `server/test/markdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { renderBlock, renderInline } from '../markdown.js';

describe('renderInline', () => {
  it('renders emphasis as markup rather than asterisks', () => {
    expect(renderInline('**bold**')).toBe('<strong>bold</strong>');
  });

  it('returns null for null, so "no description" stays distinguishable', () => {
    expect(renderInline(null)).toBeNull();
  });

  it('does not let a description that starts with a hash become a heading', () => {
    const html = renderInline('# Heading');
    expect(html).not.toContain('<h1');
  });

  it('strips images, which would break the card grid', () => {
    const html = renderInline('![badge](https://img.example/b.svg)');
    expect(html).not.toContain('<img');
  });
});

describe('renderBlock', () => {
  it('renders a heading', () => {
    expect(renderBlock('# Title')).toContain('<h1');
  });

  it('keeps an https image, because README badges are normal', () => {
    const html = renderBlock('![badge](https://img.example/b.svg)');
    expect(html).toContain('<img');
    expect(html).toContain('https://img.example/b.svg');
  });

  it('drops an http image, since the page is served over https', () => {
    expect(renderBlock('![b](http://img.example/b.svg)')).not.toContain('http://img.example');
  });
});

// These are the tests that must fail loudly if the sanitiser is ever removed,
// reconfigured or swapped. Package READMEs are publisher controlled, so this is
// the only thing between a plugin author and script execution on gl3.dev.
describe('sanitising publisher content', () => {
  it('removes a script tag', () => {
    const html = renderBlock('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('removes an event handler attribute', () => {
    const html = renderBlock('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('removes a javascript: link', () => {
    const html = renderBlock('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('removes a style tag', () => {
    expect(renderBlock('<style>body{display:none}</style>')).not.toContain('<style');
  });

  it('hardens links, so a publisher cannot reach back through window.opener', () => {
    const html = renderBlock('[docs](https://example.com)');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('hardens links in inline rendering too', () => {
    const html = renderInline('[docs](https://example.com)');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm test -- server/test/markdown.test.ts`
Expected: FAIL, cannot resolve `../markdown.js`.

- [ ] **Step 4: Write the module**

Create `server/markdown.ts`:

```ts
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

/**
 * Turns package README markdown into HTML.
 *
 * Package READMEs are publisher controlled, so everything here is sanitised on
 * the way out. There is deliberately no unsanitised path: the catalogue has no
 * notion of a trusted publisher, so an exception for one would be an exception
 * for all of them.
 *
 * This runs on the server rather than in the browser because the site is built
 * by GitHub Actions, where store-api is unreachable, so nothing can be rendered
 * from catalogue data at build time. Keeping it here also means no markdown
 * parser and no sanitiser ship to visitors.
 */

// Allowlist, never a denylist: sanitize-html's defaults permit a known set of
// tags, so script, style and every event handler attribute are excluded by not
// being named rather than by being blocked.
const baseOptions: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags],
  allowedAttributes: {
    a: ['href', 'title'],
    code: ['class'],
    span: ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    // noopener and noreferrer stop a linked page reaching back through
    // window.opener. target=_blank keeps a publisher's link from navigating
    // the storefront away from itself.
    a: sanitizeHtml.simpleTransform('a', {
      rel: 'noopener noreferrer',
      target: '_blank',
    }),
  },
};

// Block rendering allows images because badges are a normal part of a README
// and stripping them leaves visible gaps. https only: these pages are served
// over https and a mixed content image would be blocked by the browser anyway.
const blockOptions: sanitizeHtml.IOptions = {
  ...baseOptions,
  allowedTags: [...baseOptions.allowedTags!, 'img'],
  allowedAttributes: {
    ...baseOptions.allowedAttributes,
    img: ['src', 'alt', 'title'],
  },
  allowedSchemesByTag: { img: ['https'] },
};

/**
 * Renders a card description.
 *
 * Inline parsing on purpose: a description is a fragment, so emphasis, inline
 * code and links should render, but a README whose first line starts with "#"
 * must not turn its card into a heading. Cards stay uniform whatever the
 * package opens with. Images are excluded for the same reason: a card is a
 * three line summary and an image in it breaks the grid.
 */
export function renderInline(src: string | null): string | null {
  if (src === null) {
    return null;
  }
  return sanitizeHtml(marked.parseInline(src, { async: false }), baseOptions);
}

/** Renders a full README for a plugin page. */
export function renderBlock(src: string | null): string | null {
  if (src === null) {
    return null;
  }
  return sanitizeHtml(marked.parse(src, { async: false }), blockOptions);
}
```

If TypeScript still widens `marked.parseInline` to `string | Promise<string>` despite `async: false`, wrap the call rather than casting at the call site:

```ts
function toHtml(fn: (s: string, o: { async: false }) => string | Promise<string>, src: string): string {
  const out = fn(src, { async: false });
  if (typeof out !== 'string') {
    throw new Error('marked returned a promise despite async: false');
  }
  return out;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test -- server/test/markdown.test.ts && npm run typecheck`
Expected: PASS, all tests green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/markdown.ts server/test/markdown.test.ts
git commit -m "feat: render package markdown to sanitised HTML on the server"
```

---

### Task 2: Rendered descriptions and a lazy detail cache

**Files:**
- Modify: `server/catalog.ts`
- Test: `server/test/catalog.test.ts`

**Interfaces:**
- Consumes: `renderInline`, `renderBlock` from Task 1.
- Produces:
  - `Plugin` gains `descriptionHtml: string | null` and `href: string`
  - `type PluginDetail = Plugin & { readmeHtml: string | null }`
  - `type DetailFetch = (packageName: string) => Promise<unknown>`, resolving to `null` when store-api returned 404 (written as `unknown` rather than `unknown | null`, which TypeScript collapses back to `unknown` anyway)
  - `createCatalog` gains a required `fetchDetail: DetailFetch` dependency and returns `getDetail(packageName: string): Promise<DetailResult>`
  - `type DetailResult = { available: boolean; plugin: PluginDetail | null }`
  - `createStoreApiDetailFetch(config: { url: string; key: string; timeoutMs: number }): DetailFetch`
  - `pluginHref(packageName: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `server/test/catalog.test.ts`. The existing file already builds catalogues with a stub fetch; follow its local helpers rather than inventing new ones, and pass a `fetchDetail` stub to every existing `createCatalog` call so the file still compiles.

```ts
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
    expect(result.plugins[0].descriptionHtml).toBe('<strong>bold</strong> pitch');
  });

  it('keeps the plain description, which the page meta tag needs', async () => {
    const catalog = createCatalog({
      fetchCatalog: async () => ({ packages: [pkg({ description: '**bold**' })] }),
      fetchDetail: async () => null,
      cacheMs: 1000,
      logger: silentLogger(),
    });

    expect((await catalog.get()).plugins[0].description).toBe('**bold**');
  });

  it('gives each plugin a page link with the scope as its own segment', async () => {
    const catalog = createCatalog({
      fetchCatalog: async () => ({ packages: [pkg({ package: '@gl3-plugins/fixer' })] }),
      fetchDetail: async () => null,
      cacheMs: 1000,
      logger: silentLogger(),
    });

    expect((await catalog.get()).plugins[0].href).toBe('/plugins/gl3-plugins/fixer.html');
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
```

If the existing file has no `pkg` helper, add one at the top of the file:

```ts
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
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- server/test/catalog.test.ts`
Expected: FAIL, `catalog.getDetail is not a function` and `descriptionHtml` undefined.

- [ ] **Step 3: Extend the module**

In `server/catalog.ts`:

```ts
import { renderBlock, renderInline } from './markdown.js';
```

Extend the type and add the href helper:

```ts
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
 * Builds a plugin's page URL.
 *
 * The scope keeps its own path segment with the "@" dropped, rather than being
 * flattened into the name with a hyphen. Flattening collides: "@gl3-plugins/fixer"
 * and "@gl3/plugins-fixer" would both become "gl3-plugins-fixer", and both
 * scopes are real in this catalogue. Two segments cannot.
 */
export function pluginHref(packageName: string): string {
  const [scope, name] = packageName.replace(/^@/, '').split('/');
  return `/plugins/${scope}/${name}.html`;
}
```

In `toPlugins`, add the two new fields:

```ts
      descriptionHtml: renderInline(pkg.description),
      href: pluginHref(pkg.package),
```

Add the detail schema beside the existing one:

```ts
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
  /** False when store-api could not be reached and nothing was cached. */
  available: boolean;
  /** Null when the package is not in the catalogue. */
  plugin: PluginDetail | null;
};
```

Inside `createCatalog`, add `fetchDetail: DetailFetch` to the dependency type, then add the per-package cache and `getDetail`:

```ts
  // Keyed by package name. Bounded by the catalogue, because getDetail refuses
  // to fetch a name the list does not contain, so a stream of invented URLs
  // cannot grow this map.
  const details = new Map<string, { plugin: PluginDetail; at: number }>();
  const detailPending = new Map<string, Promise<DetailResult>>();

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
      return { available: true, plugin };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cachedDetail = details.get(packageName);

      if (cachedDetail !== undefined) {
        // Last known good, the same rule the list follows. A stale readme is
        // always better than an error page.
        deps.logger.warn('detail refresh failed, serving cache', {
          package: packageName,
          err: message,
        });
        return { available: true, plugin: cachedDetail.plugin };
      }

      deps.logger.error('detail unavailable and nothing cached', {
        package: packageName,
        err: message,
      });
      return { available: false, plugin: null };
    }
  }
```

and, in the returned object:

```ts
    async getDetail(packageName: string): Promise<DetailResult> {
      const listed = await this.get();
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

      let inFlight = detailPending.get(packageName);
      if (inFlight === undefined) {
        inFlight = refreshDetail(packageName, list).finally(() => {
          detailPending.delete(packageName);
        });
        detailPending.set(packageName, inFlight);
      }

      return inFlight;
    },
```

`this.get()` requires the returned object to be a named const rather than an object literal returned directly. Restructure as:

```ts
  const api = {
    async get(): Promise<CatalogResult> { /* unchanged body */ },
    async getDetail(packageName: string): Promise<DetailResult> { /* above, calling api.get() */ },
  };
  return api;
```

- [ ] **Step 4: Add the detail client**

Append to `server/catalog.ts`:

```ts
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
```

`encodeURIComponent` is load-bearing: store-api's route will never match an unencoded slash in a scoped name, it reads as two path segments.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test && npm run typecheck`
Expected: PASS. Existing catalogue tests must still pass; update their `createCatalog` calls with a `fetchDetail` stub, not by loosening the type.

- [ ] **Step 6: Commit**

```bash
git add server/catalog.ts server/test/catalog.test.ts
git commit -m "feat: render descriptions and cache per-package readmes"
```

---

### Task 3: The plugin page renderer

**Files:**
- Create: `server/plugin-page.ts`
- Modify: `server/env.ts`
- Test: `server/test/plugin-page.test.ts`, `server/test/env.test.ts`

**Interfaces:**
- Consumes: `PluginDetail`, `Plugin` from Task 2.
- Produces:
  - `discoverStylesheets(siteDist: string): Promise<string[]>`
  - `renderPluginPage(input: { plugin: PluginDetail; stylesheets: string[]; origin: string }): string`
  - `renderSitemap(input: { plugins: Plugin[]; origin: string }): string`
  - `env` gains `PUBLIC_ORIGIN`

- [ ] **Step 1: Add PUBLIC_ORIGIN to the environment**

In `server/env.ts`, inside the schema:

```ts
  // Absolute base URL this site is served from. Needed by the sitemap and the
  // Open Graph tags, which cannot use relative URLs.
  PUBLIC_ORIGIN: z
    .string()
    .url()
    .default('https://gl3.dev')
    .transform((value) => value.replace(/\/+$/, '')),
```

Add to `server/test/env.test.ts`:

```ts
it('defaults PUBLIC_ORIGIN and strips a trailing slash', () => {
  expect(loadEnv(validEnv()).PUBLIC_ORIGIN).toBe('https://gl3.dev');
  expect(loadEnv({ ...validEnv(), PUBLIC_ORIGIN: 'https://x.dev/' }).PUBLIC_ORIGIN).toBe(
    'https://x.dev'
  );
});
```

Use whatever helper the existing file already has for a valid environment rather than adding a second one.

- [ ] **Step 2: Write the failing tests**

Create `server/test/plugin-page.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { Plugin, PluginDetail } from '../catalog.js';
import { renderPluginPage, renderSitemap } from '../plugin-page.js';

function plugin(overrides: Partial<PluginDetail> = {}): PluginDetail {
  return {
    name: '@gl3-plugins/fixer',
    paid: true,
    version: '0.1.9',
    description: 'An AI contract broker',
    descriptionHtml: 'An AI contract broker',
    keywords: ['gl3'],
    license: 'MIT',
    install: 'npm install @gl3-plugins/fixer',
    href: '/plugins/gl3-plugins/fixer.html',
    readmeHtml: '<h1>Fixer</h1>',
    ...overrides,
  };
}

const origin = 'https://gl3.dev';

describe('renderPluginPage', () => {
  it('includes the rendered readme', () => {
    expect(renderPluginPage({ plugin: plugin(), stylesheets: [], origin })).toContain(
      '<h1>Fixer</h1>'
    );
  });

  it('titles the page after the package', () => {
    expect(renderPluginPage({ plugin: plugin(), stylesheets: [], origin })).toContain(
      '<title>@gl3-plugins/fixer'
    );
  });

  it('uses the plain description in the meta tag, not the markup', () => {
    const html = renderPluginPage({
      plugin: plugin({ description: '**bold**', descriptionHtml: '<strong>bold</strong>' }),
      stylesheets: [],
      origin,
    });
    expect(html).toContain('content="**bold**"');
  });

  it('links every discovered stylesheet', () => {
    const html = renderPluginPage({
      plugin: plugin(),
      stylesheets: ['/assets/style.abc123.css'],
      origin,
    });
    expect(html).toContain('href="/assets/style.abc123.css"');
  });

  it('still renders when no stylesheet was discovered', () => {
    const html = renderPluginPage({ plugin: plugin(), stylesheets: [], origin });
    expect(html).toContain('<h1>Fixer</h1>');
    expect(html).toContain('<style>');
  });

  it('says so when the readme has not been fetched', () => {
    const html = renderPluginPage({
      plugin: plugin({ readmeHtml: null }),
      stylesheets: [],
      origin,
    });
    expect(html).toContain('No description has been published');
  });

  it('escapes the package name in the title', () => {
    const html = renderPluginPage({
      plugin: plugin({ name: '@gl3/<script>alert(1)</script>' }),
      stylesheets: [],
      origin,
    });
    // Assert on the escaped form rather than the absence of "<script>": the
    // page carries its own theme script, so a bare absence check would fail
    // on the page's own markup and prove nothing about the package name.
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('gives Open Graph an absolute URL', () => {
    const html = renderPluginPage({ plugin: plugin(), stylesheets: [], origin });
    expect(html).toContain('https://gl3.dev/plugins/gl3-plugins/fixer.html');
  });
});

describe('renderSitemap', () => {
  it('lists the built pages and every plugin page', () => {
    const xml = renderSitemap({ plugins: [plugin() as Plugin], origin });
    expect(xml).toContain('<loc>https://gl3.dev/</loc>');
    expect(xml).toContain('<loc>https://gl3.dev/plugins.html</loc>');
    expect(xml).toContain('<loc>https://gl3.dev/plugins/gl3-plugins/fixer.html</loc>');
  });

  it('is well formed when the catalogue is empty', () => {
    const xml = renderSitemap({ plugins: [], origin });
    expect(xml).toContain('<urlset');
    expect(xml).toContain('</urlset>');
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm test -- server/test/plugin-page.test.ts`
Expected: FAIL, cannot resolve `../plugin-page.js`.

- [ ] **Step 4: Write the renderer**

Create `server/plugin-page.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Plugin, PluginDetail } from './catalog.js';

/**
 * Renders a plugin's page as a standalone HTML document.
 *
 * Deliberately not a VitePress page. VitePress hydrates with Vue, and Vue
 * replaces server rendered DOM that does not match what it expects, so
 * injecting a readme into a built page would be a fight over the same nodes.
 * This document links the built stylesheet and uses VitePress's own custom
 * properties instead, so it matches the palette without running the app.
 *
 * The visible cost is that these pages have no nav bar, search box or theme
 * toggle. The alternative, rendering the whole section in the browser, gives up
 * the prerendering these pages exist for.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Finds the built stylesheet, whose filename is content hashed per build.
 *
 * Returns an empty list rather than throwing when the build output is missing
 * or shaped differently: the page then falls back to its own base styles, so a
 * restructured build degrades the appearance rather than the page.
 */
export async function discoverStylesheets(siteDist: string): Promise<string[]> {
  try {
    const html = await readFile(join(siteDist, 'index.html'), 'utf-8');
    return [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
      (match) => match[1]
    );
  } catch {
    return [];
  }
}

// Enough to be readable on its own. Only reached when the built stylesheet
// could not be found, so it is a fallback rather than the design.
const FALLBACK_STYLES = `
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 46rem; padding: 2rem 1rem;
         font: 16px/1.6 system-ui, sans-serif; }
  pre { overflow-x: auto; padding: 1rem; background: rgba(127,127,127,.12); }
  img { max-width: 100%; }
`;

// Applies the theme the rest of the site stored, so a visitor in dark mode does
// not hit a white page. The key is VitePress's own.
const THEME_SCRIPT = `
try {
  var pref = localStorage.getItem('vitepress-theme-appearance');
  if (pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch (e) {}
`;

export function renderPluginPage(input: {
  plugin: PluginDetail;
  stylesheets: string[];
  origin: string;
}): string {
  const { plugin, stylesheets, origin } = input;

  const title = escapeHtml(plugin.name);
  const description = escapeHtml(plugin.description ?? `${plugin.name} for GL3`);
  const canonical = escapeHtml(`${origin}${plugin.href}`);
  const tier = plugin.paid ? 'Premium' : 'Free';

  const links =
    stylesheets.length > 0
      ? stylesheets.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('')
      : `<style>${FALLBACK_STYLES}</style>`;

  const readme =
    plugin.readmeHtml ??
    '<p>No description has been published for this plugin yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | GL3 plugins</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
${links}
<script>${THEME_SCRIPT}</script>
</head>
<body class="gl3-plugin-page">
<header class="gl3-plugin-page-header">
  <a href="/">GL3</a>
  <a href="/plugins.html">Plugins</a>
</header>
<main>
  <h1>${title}</h1>
  <p class="gl3-plugin-page-meta">
    <span>${tier}</span>
    <span>v${escapeHtml(plugin.version)}</span>
    ${plugin.license === null ? '' : `<span>${escapeHtml(plugin.license)}</span>`}
  </p>
  <pre><code>${escapeHtml(plugin.install)}</code></pre>
  <article>${readme}</article>
</main>
<footer>
  <p>Documentation at <a href="https://docs.gl3.dev">docs.gl3.dev</a>.</p>
</footer>
</body>
</html>`;
}

// The site's built pages. Hard coded rather than read from the build output:
// the list is four entries that change when someone adds a page, and walking
// the dist directory would also pick up assets and the 404.
const STATIC_PATHS = ['/', '/plugins.html', '/pricing.html', '/get-started.html'];

/**
 * Lists every page for crawlers.
 *
 * Load bearing rather than decorative: the plugin grid is rendered in the
 * browser, so a crawler following links would never reach a plugin page. This
 * is the only path by which they are discoverable.
 */
export function renderSitemap(input: { plugins: Plugin[]; origin: string }): string {
  const paths = [...STATIC_PATHS, ...input.plugins.map((plugin) => plugin.href)];
  const urls = paths
    .map((path) => `  <url><loc>${escapeHtml(`${input.origin}${path}`)}</loc></url>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/plugin-page.ts server/env.ts server/test/plugin-page.test.ts server/test/env.test.ts
git commit -m "feat: render standalone plugin pages and a sitemap"
```

---

### Task 4: The routes

**Files:**
- Modify: `server/app.ts`, `server/index.ts`
- Test: `server/test/app.test.ts`

**Interfaces:**
- Consumes: `getDetail` from Task 2, `renderPluginPage`, `renderSitemap`, `discoverStylesheets` from Task 3.
- Produces: `AppDeps` gains `stylesheets: string[]` and `origin: string`.

- [ ] **Step 1: Write the failing tests**

Append to `server/test/app.test.ts`, following the existing helper that builds an app with a stub catalogue. That stub now needs a `getDetail`.

```ts
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
  // happens to sit at the same path must not shadow the route. E1 got this
  // ordering wrong once already.
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
```

Add the two local helpers to the file:

```ts
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
```

with `import type { Plugin, PluginDetail } from '../catalog.js';` at the top.

Create the fixture the ordering test needs:
`server/test/fixtures/site/plugins/gl3-plugins/fixer.html` containing `static wins`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- server/test/app.test.ts`
Expected: FAIL with 404s from the static handler, since the routes do not exist.

- [ ] **Step 3: Add the routes**

In `server/app.ts`, widen the dependencies:

```ts
import type { CatalogResult, DetailResult } from './catalog.js';
import { renderPluginPage, renderSitemap } from './plugin-page.js';

export type AppDeps = {
  catalog: {
    get: () => Promise<CatalogResult>;
    getDetail: (packageName: string) => Promise<DetailResult>;
  };
  logger?: Logger;
  siteDist?: string;
  /** Built stylesheet paths, discovered at startup. */
  stylesheets?: string[];
  /** Absolute base URL, for canonical links and the sitemap. */
  origin?: string;
};
```

Default `stylesheets = []` and `origin = 'https://gl3.dev'` in the destructure.

Add both routes above the static handler:

```ts
  // Only our own scopes. Rejecting anything else here means an invented URL
  // never reaches store-api.
  const SCOPES = new Set(['gl3', 'gl3-plugins']);

  app.get('/plugins/:scope/:file', async (c, next) => {
    const scope = c.req.param('scope');
    const file = c.req.param('file');

    if (!SCOPES.has(scope) || !file.endsWith('.html')) {
      // next() rather than a 404 here, so a real file at this path is still
      // served and the notFound handler produces the styled page.
      return next();
    }

    const packageName = `@${scope}/${file.slice(0, -'.html'.length)}`;
    const result = await catalog.getDetail(packageName);

    if (!result.available) {
      // 503 rather than 404: an outage must not be recorded by a crawler as a
      // permanent absence.
      return c.text('The plugin catalogue is not reachable right now.', 503);
    }

    if (result.plugin === null) {
      return next();
    }

    return c.html(renderPluginPage({ plugin: result.plugin, stylesheets, origin }));
  });

  app.get('/sitemap.xml', async (c) => {
    const { plugins } = await catalog.get();
    return c.text(renderSitemap({ plugins, origin }), 200, {
      'content-type': 'application/xml; charset=UTF-8',
    });
  });
```

- [ ] **Step 4: Wire it up at startup**

In `server/index.ts`, discover the stylesheets once and pass the new dependencies:

```ts
const stylesheets = await discoverStylesheets(env.SITE_DIST);

const catalog = createCatalog({
  fetchCatalog: createStoreApiFetch({ url: env.STORE_API_URL, key: env.INTERNAL_API_KEY, timeoutMs: 5000 }),
  fetchDetail: createStoreApiDetailFetch({ url: env.STORE_API_URL, key: env.INTERNAL_API_KEY, timeoutMs: 5000 }),
  cacheMs: env.CATALOG_CACHE_MS,
  logger,
});

const app = createApp({
  catalog,
  logger,
  siteDist: env.SITE_DIST,
  stylesheets,
  origin: env.PUBLIC_ORIGIN,
});
```

Match the existing file's timeout value rather than introducing a new one.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS, and the build completes.

- [ ] **Step 6: Commit**

```bash
git add server/app.ts server/index.ts server/test/app.test.ts server/test/fixtures
git commit -m "feat: serve a page per plugin and a sitemap"
```

---

### Task 5: The card

**Files:**
- Modify: `site/.vitepress/theme/components/PluginGrid.vue`, `site/.vitepress/theme/custom.css`

**Interfaces:**
- Consumes: `descriptionHtml` and `href` on each plugin from `/api/plugins`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Render the description and link the card**

In the template, replace the description paragraph and make the heading a link:

```vue
        <header>
          <h3><a :href="plugin.href">{{ plugin.name }}</a></h3>
          <span :class="['gl3-tag', plugin.paid ? 'is-paid' : 'is-free']">
            {{ plugin.paid ? 'Premium' : 'Free' }}
          </span>
        </header>

        <div v-if="plugin.descriptionHtml" class="gl3-plugin-description">
          <!-- Already sanitised by the server, which is the only place package
               markdown becomes HTML. Nothing here re-parses it. -->
          <p
            :class="{ 'is-clamped': !expanded.has(plugin.name) }"
            :ref="(el) => registerDescription(plugin.name, el)"
            v-html="plugin.descriptionHtml"
          ></p>
          <button
            v-if="overflowing.has(plugin.name)"
            type="button"
            class="gl3-plugin-more"
            :aria-expanded="expanded.has(plugin.name)"
            @click="toggle(plugin.name)"
          >
            {{ expanded.has(plugin.name) ? 'Show less' : 'Show more' }}
          </button>
        </div>
```

- [ ] **Step 2: Add the clamp state**

In `<script setup>`:

```js
import { nextTick, onMounted, ref } from 'vue'

const expanded = ref(new Set())
const overflowing = ref(new Set())
const descriptionEls = new Map()

function registerDescription(name, el) {
  if (el === null) {
    descriptionEls.delete(name)
  } else {
    descriptionEls.set(name, el)
  }
}

function toggle(name) {
  const next = new Set(expanded.value)
  next.has(name) ? next.delete(name) : next.add(name)
  expanded.value = next
}

// A control that expands nothing is worse than no control, so it only appears
// on the cards whose text is actually taller than the clamp allows.
function measure() {
  const next = new Set()
  for (const [name, el] of descriptionEls) {
    if (el.scrollHeight > el.clientHeight + 1) {
      next.add(name)
    }
  }
  overflowing.value = next
}
```

Call `await nextTick()` then `measure()` at the end of the successful branch in `onMounted`, after `state.value = ...` is set, so the elements exist.

- [ ] **Step 3: Add the styles**

In `site/.vitepress/theme/custom.css`:

```css
.gl3-plugin-description p.is-clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.gl3-plugin-description :is(strong, em, code) {
  /* Publisher markup renders inside a card, so it must not change the line box. */
  font-size: inherit;
}

.gl3-plugin-more {
  background: none;
  border: 0;
  padding: 0;
  color: var(--vp-c-brand-1);
  cursor: pointer;
  font: inherit;
}
```

- [ ] **Step 4: Check it by eye**

Run: `npm run build:site && npm run build:server && npm start`

With store-api reachable, open `/plugins.html` and confirm: the Fixer card shows bold text rather than asterisks, long descriptions clamp to three lines with a working "Show more", short ones have no control, and the card title links to a page that renders the full README. Then open `/sitemap.xml` and confirm the plugin URLs are listed.

- [ ] **Step 5: Commit**

```bash
git add site/.vitepress/theme/components/PluginGrid.vue site/.vitepress/theme/custom.css
git commit -m "feat: render and clamp card descriptions, link each card to its page"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the new behaviour**

Add to the README: the two new routes, `PUBLIC_ORIGIN` in the environment table, and a short note recording why markdown is rendered on the server rather than in the browser, since that is the decision a future reader is most likely to want to undo without knowing the constraint behind it.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: record the plugin page routes and server side rendering"
```
