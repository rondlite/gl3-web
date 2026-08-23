# Plugin Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** store-api holds a curated list of GL3 package names, caches each one's registry metadata on a background timer, and serves it to gl3-web over authenticated routes.

**Architecture:** One table where `position` is curated and every other column is an overwritable cache of the registry manifest. A timer in the process refreshes each row using an HTTP Basic credential (the `storefront` service account from sub-project A), and never blanks a cached value when a fetch fails. Two read routes serve gl3-web; two admin routes maintain the list.

**Tech Stack:** Node 22, TypeScript 5.8 ESM, Hono 4.7, zod 3.24, `pg` 8.14, Vitest 3.1 against a real Postgres.

**Spec:** `docs/superpowers/specs/2026-08-23-plugin-catalogue-design.md`

## Global Constraints

- **Repository:** `rondlite/gl3-store-api` only. No other repo changes.
- **Do not loosen the entitlement validators.** `parsePattern` and `isSellablePackage` in `src/packages.ts` are a security boundary and must keep rejecting `@gl3/*`. The catalogue gets its own separate validator. A regression test pins this.
- **Catalogue package names:** either GL3 scope — `@gl3-plugins/<name>` or `@gl3/<name>`. Anything else is `400 {"error":"invalid_package"}`.
- **`paid` is derived** from the `@gl3-plugins/` prefix, never stored.
- **All four `REGISTRY_*` variables are optional.** Every current deployment sets none of them; with any of URL/username/token missing the refresher does not start, logs once, and the routes still serve whatever is in the table. This also keeps the test suite off the network.
- **Last-known-good is the rule.** A failed fetch never clears a previously good cached value. On a thrown error `fetched_at` is deliberately *not* stamped, so staleness keeps growing rather than being masked.
- **`refreshCatalog` never throws.** It runs from a timer callback; an escaping rejection would be unhandled.
- **Never refresh inside a request.** store-api fetching from the registry makes the registry call back into store-api through the auth plugin, so a request-path refresh waits on itself.
- **Registry client timeout is 10s**, deliberately longer than the auth plugin's 5s inner timeout, so a slow inner hop surfaces as the plugin's failure rather than an ambiguous outer one.
- **Migrations are append-only.** Never edit `001_init.sql` or `002_entitlement_access.sql`.
- **ESM:** relative imports carry a `.js` suffix even for `.ts` sources (`./packages.js`).
- **Tests:** real Postgres, no mocks, `fileParallelism: false` (already set — do not change it). Run with:
  `TEST_DATABASE_URL="postgres:///gl3_store_test?host=/var/run/postgresql" npx vitest run`
- **Baseline before this work:** 39/39 passing, `npm run typecheck` clean. Every existing test must still pass.

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `migrations/003_catalog_packages.sql` | create | The table |
| `src/packages.ts` | modify | Catalogue-name validator and the paid/free derivation, alongside the untouched entitlement validators |
| `src/registry.ts` | create | One function: fetch a manifest over HTTP Basic |
| `src/catalog-refresh.ts` | create | One refresh pass, and the timer that drives it |
| `src/service.ts` | modify | Catalogue queries |
| `src/app.ts` | modify | Two read routes, two admin routes, one presenter |
| `src/env.ts` | modify | The four optional `REGISTRY_*` variables |
| `src/index.ts` | modify | Start and stop the refresher |
| `test/helpers.ts` | modify | Truncate the new table between tests |
| `test/catalog.test.ts` | create | Everything above |
| `README.md` | modify | Routes, the catalogue model, and the operator runbook |

---

## Task 1: The table, the validator, and the admin routes

**Files:**
- Create: `migrations/003_catalog_packages.sql`
- Modify: `src/packages.ts`, `src/service.ts`, `src/app.ts`, `test/helpers.ts`
- Test: `test/catalog.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `isCatalogPackage(name: string): boolean` and `isPaidPackage(name: string): boolean` and `PUBLIC_SCOPE` from `src/packages.ts`; `addCatalogPackage(db, {package, position}): Promise<void>` and `removeCatalogPackage(db, packageName): Promise<boolean>` from `src/service.ts`; routes `POST /v1/admin/catalog` and `DELETE /v1/admin/catalog/:package`.

- [ ] **Step 1: Add the new table to the test truncate**

In `test/helpers.ts`, the `beforeEach` currently truncates four tables. Add the new one — without this, catalogue rows leak between tests and the ordering assertions fail confusingly:

```ts
  beforeEach(async () => {
    await harness.db.query(
      'truncate users, user_roles, tokens, entitlements, catalog_packages cascade'
    );
  });
```

- [ ] **Step 2: Write the failing tests**

Create `test/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { setupHarness } from './helpers.js';

const h = setupHarness();

function addPkg(body: Record<string, unknown>) {
  return h.call('/v1/admin/catalog', { method: 'POST', body: JSON.stringify(body) });
}

describe('POST /v1/admin/catalog', () => {
  it('accepts a paid-scope package', async () => {
    const res = await addPkg({ package: '@gl3-plugins/plugin-a', position: 10 });
    expect(res.status).toBe(201);

    const { rows } = await h.db.query<{ package: string; position: number }>(
      'select package, position from catalog_packages'
    );
    expect(rows).toEqual([{ package: '@gl3-plugins/plugin-a', position: 10 }]);
  });

  it('accepts a public-scope package', async () => {
    // The site is GL3's actual website, so the SDK belongs in the directory too.
    expect((await addPkg({ package: '@gl3/plugin-sdk', position: 1 })).status).toBe(201);
  });

  it('rejects a package outside both GL3 scopes', async () => {
    const res = await addPkg({ package: 'lodash', position: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_package' });
  });

  it('upserts rather than duplicating, so a repeat call repositions', async () => {
    await addPkg({ package: '@gl3-plugins/plugin-a', position: 10 });
    await addPkg({ package: '@gl3-plugins/plugin-a', position: 3 });

    const { rows } = await h.db.query<{ position: number }>(
      'select position from catalog_packages'
    );
    expect(rows).toEqual([{ position: 3 }]);
  });
});

describe('DELETE /v1/admin/catalog/:package', () => {
  it('removes a package', async () => {
    await addPkg({ package: '@gl3-plugins/plugin-a', position: 1 });

    const res = await h.call(
      `/v1/admin/catalog/${encodeURIComponent('@gl3-plugins/plugin-a')}`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(200);

    const { rows } = await h.db.query('select 1 from catalog_packages');
    expect(rows).toHaveLength(0);
  });

  it('404s on a package that is not catalogued', async () => {
    const res = await h.call(
      `/v1/admin/catalog/${encodeURIComponent('@gl3-plugins/nope')}`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(404);
  });
});

describe('entitlement validators stay narrow', () => {
  it('refuses to authorize a public-scope package', async () => {
    // The catalogue admits @gl3/*; the entitlement check must not. Widening
    // this would push free packages through the paid authorization path.
    const created = await h.call('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron', email: 'ron@gl3.dev' }),
    });
    const { userId } = (await created.json()) as { userId: string };

    const res = await h.call('/v1/auth/authorize-package', {
      method: 'POST',
      body: JSON.stringify({ userId, package: '@gl3/plugin-sdk' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'out_of_scope' });
  });

  it('refuses to grant an entitlement on the public scope', async () => {
    const created = await h.call('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'ron2', email: 'ron2@gl3.dev' }),
    });
    const { userId } = (await created.json()) as { userId: string };

    const res = await h.call(`/v1/admin/users/${userId}/entitlements`, {
      method: 'POST',
      body: JSON.stringify({ package: '@gl3/*' }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test?host=/var/run/postgresql" npx vitest run test/catalog.test.ts
```

Expected: failures reading `relation "catalog_packages" does not exist`.

- [ ] **Step 4: Add the migration**

Create `migrations/003_catalog_packages.sql`:

```sql
-- The package directory the website renders: the paid plugins premium unlocks,
-- and the public scope developers build against.
--
-- `position` is the only curated column -- it is set through the admin routes and
-- is nobody else's to write. Everything from `version` down is a cache of what
-- the registry last returned: overwritten wholesale by the refresher, and safe
-- to lose. Losing it costs one refresh cycle, not data.
create table catalog_packages (
  package     text primary key,
  position    integer not null,
  added_at    timestamptz not null default now(),
  version     text,
  description text,
  keywords    text[],
  license     text,
  readme      text,
  fetched_at  timestamptz,
  fetch_error text
);

-- Ordering is (position, package) rather than position alone so two rows sharing
-- a position still produce a stable list instead of an arbitrary one.
create index catalog_packages_position_idx on catalog_packages (position, package);
```

- [ ] **Step 5: Add the catalogue validator**

Append to `src/packages.ts`. Do not modify `parsePattern` or `isSellablePackage`:

```ts
/**
 * The public scope: the SDK and anything else given away. Readable by anyone
 * straight from the registry, and never entitlement-checked.
 */
export const PUBLIC_SCOPE = '@gl3/';

const CATALOG_NAME = /^@gl3(-plugins)?\/[a-z0-9][a-z0-9._-]*$/;

/**
 * A package name allowed in the website's catalogue: either GL3 scope.
 *
 * Deliberately separate from `isSellablePackage`. The catalogue is a display
 * list and spans both scopes; entitlement checks are a security boundary and
 * must keep rejecting the free scope.
 */
export function isCatalogPackage(name: string): boolean {
  return CATALOG_NAME.test(name);
}

/**
 * True for names in the paid scope.
 *
 * Derived rather than stored, so it cannot drift from the name. The assumption
 * is that everything under the paid scope is paid, which Verdaccio's
 * `public_packages` setting could falsify by freeing a name inside that scope
 * without renaming it. That list is empty today.
 */
export function isPaidPackage(name: string): boolean {
  return name.startsWith(SCOPE);
}
```

- [ ] **Step 6: Add the service functions**

Append to `src/service.ts`:

```ts
export async function addCatalogPackage(
  db: Db,
  input: { package: string; position: number }
): Promise<void> {
  // Upsert so the same call both adds a package and moves an existing one.
  await db.query(
    `insert into catalog_packages (package, position)
          values ($1, $2)
     on conflict (package) do update set position = excluded.position`,
    [input.package, input.position]
  );
}

export async function removeCatalogPackage(db: Db, packageName: string): Promise<boolean> {
  const { rowCount } = await db.query('delete from catalog_packages where package = $1', [
    packageName,
  ]);
  return (rowCount ?? 0) > 0;
}
```

- [ ] **Step 7: Add the admin routes**

In `src/app.ts`, extend the import from `./packages.js`:

```ts
import { PUBLIC_SCOPE, SCOPE, isCatalogPackage, isSellablePackage, parsePattern } from './packages.js';
```

and the import from `./service.js` to include `addCatalogPackage` and `removeCatalogPackage`, keeping the existing alphabetical order.

Add the routes after the existing entitlement routes, before `return app;`:

```ts
  app.post(
    '/v1/admin/catalog',
    zValidator('json', z.object({ package: z.string().min(1), position: z.number().int() })),
    async (c) => {
      const body = c.req.valid('json');

      if (!isCatalogPackage(body.package)) {
        return c.json(
          {
            error: 'invalid_package',
            message: `expected "${SCOPE}name" or "${PUBLIC_SCOPE}name"`,
          },
          400
        );
      }

      await addCatalogPackage(db, body);
      return c.json({ ok: true }, 201);
    }
  );

  app.delete('/v1/admin/catalog/:package', async (c) => {
    const removed = await removeCatalogPackage(db, c.req.param('package'));
    return removed ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });
```

Hono decodes the `:package` parameter, so `@gl3-plugins%2Fplugin-a` arrives as `@gl3-plugins/plugin-a` with no manual decoding. An unencoded slash never matches the route at all.

- [ ] **Step 8: Run the tests and watch them pass**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test?host=/var/run/postgresql" npx vitest run
npm run typecheck
```

Expected: everything green, including all 39 pre-existing tests.

- [ ] **Step 9: Commit**

```bash
git add migrations/003_catalog_packages.sql src/packages.ts src/service.ts src/app.ts test/helpers.ts test/catalog.test.ts
git commit -m "feat: catalogue table and admin routes

The website's package directory spans both GL3 scopes, so the catalogue
gets its own name validator rather than loosening the entitlement ones --
those stay narrow because they are a security boundary."
```

---

## Task 2: Read routes

**Files:**
- Modify: `src/service.ts`, `src/app.ts`
- Test: `test/catalog.test.ts`

**Interfaces:**
- Consumes: the `catalog_packages` table, `isPaidPackage`, and `addCatalogPackage` from Task 1.
- Produces: `CatalogRow` type, `listCatalog(db): Promise<CatalogRow[]>`, `getCatalogPackage(db, name): Promise<CatalogRow | null>`; routes `GET /v1/catalog/packages` and `GET /v1/catalog/packages/:package`; `AppDeps` gains optional `catalogStaleMs`.

- [ ] **Step 1: Write the failing tests**

Append to `test/catalog.test.ts`. Reuse the `addPkg` helper already defined at the top of the file:

```ts
async function seedRow(pkg: string, position: number, fields: Record<string, unknown> = {}) {
  await addPkg({ package: pkg, position });
  const sets: string[] = [];
  const vals: unknown[] = [pkg];
  for (const [k, v] of Object.entries(fields)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (sets.length > 0) {
    await h.db.query(`update catalog_packages set ${sets.join(', ')} where package = $1`, vals);
  }
}

describe('GET /v1/catalog/packages', () => {
  it('orders by position then package', async () => {
    await seedRow('@gl3-plugins/b', 2);
    await seedRow('@gl3-plugins/a', 1);
    await seedRow('@gl3/sdk', 1);

    const res = await h.call('/v1/catalog/packages');
    expect(res.status).toBe(200);
    const { packages } = (await res.json()) as { packages: { package: string }[] };
    expect(packages.map((p) => p.package)).toEqual([
      '@gl3-plugins/a',
      '@gl3/sdk',
      '@gl3-plugins/b',
    ]);
  });

  it('derives paid from the scope', async () => {
    await seedRow('@gl3-plugins/a', 1);
    await seedRow('@gl3/sdk', 2);

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { package: string; paid: boolean }[];
    };
    expect(packages.map((p) => [p.package, p.paid])).toEqual([
      ['@gl3-plugins/a', true],
      ['@gl3/sdk', false],
    ]);
  });

  it('omits the readme from the list', async () => {
    await seedRow('@gl3-plugins/a', 1, { readme: '# hello' });

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: Record<string, unknown>[];
    };
    expect(packages[0]).not.toHaveProperty('readme');
    expect(packages[0]).toMatchObject({ package: '@gl3-plugins/a' });
  });

  it('marks a never-fetched package stale', async () => {
    await seedRow('@gl3-plugins/a', 1);

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean; fetchedAt: string | null }[];
    };
    expect(packages[0].stale).toBe(true);
    expect(packages[0].fetchedAt).toBeNull();
  });

  it('marks a freshly fetched package not stale', async () => {
    await seedRow('@gl3-plugins/a', 1, { version: '1.0.0' });
    await h.db.query("update catalog_packages set fetched_at = now() where package = $1", [
      '@gl3-plugins/a',
    ]);

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean; version: string }[];
    };
    expect(packages[0].stale).toBe(false);
    expect(packages[0].version).toBe('1.0.0');
  });

  it('marks a package with a recorded fetch error stale even when recently fetched', async () => {
    await seedRow('@gl3-plugins/a', 1, { fetch_error: 'not_published' });
    await h.db.query("update catalog_packages set fetched_at = now() where package = $1", [
      '@gl3-plugins/a',
    ]);

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean }[];
    };
    expect(packages[0].stale).toBe(true);
  });

  it('marks a package stale once the fetch is older than two intervals', async () => {
    await seedRow('@gl3-plugins/a', 1);
    await h.db.query(
      "update catalog_packages set fetched_at = now() - interval '2 hours' where package = $1",
      ['@gl3-plugins/a']
    );

    const { packages } = (await (await h.call('/v1/catalog/packages')).json()) as {
      packages: { stale: boolean }[];
    };
    expect(packages[0].stale).toBe(true);
  });
});

describe('GET /v1/catalog/packages/:package', () => {
  it('includes the readme', async () => {
    await seedRow('@gl3-plugins/a', 1, { readme: '# hello', description: 'd' });

    const res = await h.call(
      `/v1/catalog/packages/${encodeURIComponent('@gl3-plugins/a')}`
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      package: '@gl3-plugins/a',
      paid: true,
      description: 'd',
      readme: '# hello',
    });
  });

  it('404s on a package that is not catalogued', async () => {
    const res = await h.call(
      `/v1/catalog/packages/${encodeURIComponent('@gl3-plugins/missing')}`
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test?host=/var/run/postgresql" npx vitest run test/catalog.test.ts
```

Expected: 404s from Hono for the unregistered routes.

- [ ] **Step 3: Add the queries**

Append to `src/service.ts`:

```ts
export type CatalogRow = {
  package: string;
  position: number;
  version: string | null;
  description: string | null;
  keywords: string[] | null;
  license: string | null;
  readme: string | null;
  fetched_at: Date | null;
  fetch_error: string | null;
};

const CATALOG_COLUMNS = `package, position, version, description, keywords, license,
                         readme, fetched_at, fetch_error`;

export async function listCatalog(db: Db): Promise<CatalogRow[]> {
  const { rows } = await db.query<CatalogRow>(
    `select ${CATALOG_COLUMNS} from catalog_packages order by position, package`
  );
  return rows;
}

export async function getCatalogPackage(
  db: Db,
  packageName: string
): Promise<CatalogRow | null> {
  const { rows } = await db.query<CatalogRow>(
    `select ${CATALOG_COLUMNS} from catalog_packages where package = $1`,
    [packageName]
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Add the presenter and the routes**

In `src/app.ts`, extend `AppDeps` and the destructure:

```ts
export type AppDeps = {
  db: Db;
  internalApiKey: string;
  logger?: Logger;
  /**
   * How old a fetch may be before the catalogue reports it stale. Two refresh
   * intervals by default, so a single missed pass is not reported as a problem.
   */
  catalogStaleMs?: number;
};
```

```ts
export function createApp({
  db,
  internalApiKey,
  logger = silentLogger(),
  catalogStaleMs = 2 * 900_000,
}: AppDeps) {
```

Add the presenter as a module-level function beside `constantTimeEquals`:

```ts
/**
 * Shapes a catalogue row for the website.
 *
 * `stale` is computed here rather than stored: a stored flag would itself go
 * stale. `paid` is derived from the name for the same reason.
 */
function presentCatalogRow(
  row: CatalogRow,
  staleMs: number,
  includeReadme: boolean
): Record<string, unknown> {
  const fetchedAt = row.fetched_at;
  const stale =
    row.fetch_error !== null || fetchedAt === null || Date.now() - fetchedAt.getTime() > staleMs;

  return {
    package: row.package,
    paid: isPaidPackage(row.package),
    position: row.position,
    version: row.version,
    description: row.description,
    keywords: row.keywords ?? [],
    license: row.license,
    fetchedAt: fetchedAt === null ? null : fetchedAt.toISOString(),
    stale,
    ...(includeReadme ? { readme: row.readme } : {}),
  };
}
```

Add `isPaidPackage` to the `./packages.js` import, and `CatalogRow`, `getCatalogPackage`, `listCatalog` to the `./service.js` import.

Register the routes beside the admin catalogue routes:

```ts
  app.get('/v1/catalog/packages', async (c) => {
    const rows = await listCatalog(db);
    return c.json({
      packages: rows.map((row) => presentCatalogRow(row, catalogStaleMs, false)),
    });
  });

  app.get('/v1/catalog/packages/:package', async (c) => {
    const row = await getCatalogPackage(db, c.req.param('package'));
    return row === null
      ? c.json({ error: 'not_found' }, 404)
      : c.json(presentCatalogRow(row, catalogStaleMs, true));
  });
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test?host=/var/run/postgresql" npx vitest run
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/service.ts src/app.ts test/catalog.test.ts
git commit -m "feat: catalogue read routes for the website

The list omits readmes -- a landing page renders cards from it, and
shipping every readme to draw a grid is waste. staleness and paid are
computed at read time so neither can drift from the row."
```

---

## Task 3: Registry client

**Files:**
- Create: `src/registry.ts`
- Test: `test/registry.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Manifest` type (`{version: string; description?: string; keywords?: string[]; license?: string; readme?: string}`), `RegistryConfig` type (`{url: string; username: string; token: string; timeoutMs: number}`), and `fetchManifest(config: RegistryConfig, packageName: string): Promise<Manifest | null>`.

- [ ] **Step 1: Write the failing tests**

Create `test/registry.test.ts`. These run a real HTTP server on an ephemeral port — no mocks, and it lets the Basic header be asserted as it goes over the wire:

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchManifest } from '../src/registry.js';

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
});

/** Starts a throwaway registry and returns the config pointing at it. */
async function startRegistry(
  handler: (url: string, auth: string | undefined) => { status: number; body?: unknown }
) {
  server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? '', req.headers.authorization);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server!.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    username: 'storefront',
    token: 'gl3_secret',
    timeoutMs: 5000,
  };
}

const MANIFEST = {
  name: '@gl3-plugins/plugin-a',
  'dist-tags': { latest: '1.2.3' },
  readme: '# plugin-a',
  versions: {
    '1.2.3': {
      version: '1.2.3',
      description: 'a paid plugin',
      keywords: ['gl3', 'plugin'],
      license: 'UNLICENSED',
    },
  },
};

describe('fetchManifest', () => {
  it('returns the latest version fields', async () => {
    const config = await startRegistry(() => ({ status: 200, body: MANIFEST }));

    expect(await fetchManifest(config, '@gl3-plugins/plugin-a')).toEqual({
      version: '1.2.3',
      description: 'a paid plugin',
      keywords: ['gl3', 'plugin'],
      license: 'UNLICENSED',
      readme: '# plugin-a',
    });
  });

  it('sends HTTP Basic credentials', async () => {
    let seen: string | undefined;
    const config = await startRegistry((_url, auth) => {
      seen = auth;
      return { status: 200, body: MANIFEST };
    });

    await fetchManifest(config, '@gl3-plugins/plugin-a');

    const expected = `Basic ${Buffer.from('storefront:gl3_secret').toString('base64')}`;
    expect(seen).toBe(expected);
  });

  it('url-encodes the scoped name', async () => {
    let seen: string | undefined;
    const config = await startRegistry((url) => {
      seen = url;
      return { status: 200, body: MANIFEST };
    });

    await fetchManifest(config, '@gl3-plugins/plugin-a');
    expect(seen).toBe('/%40gl3-plugins%2Fplugin-a');
  });

  it('resolves null for 404 — a curated but unpublished package is normal', async () => {
    const config = await startRegistry(() => ({ status: 404, body: { error: 'no such package' } }));
    expect(await fetchManifest(config, '@gl3-plugins/nope')).toBeNull();
  });

  it('throws on 403, so a broken credential is never mistaken for an empty package', async () => {
    const config = await startRegistry(() => ({ status: 403, body: { error: 'denied' } }));
    await expect(fetchManifest(config, '@gl3-plugins/plugin-a')).rejects.toThrow(/403/);
  });

  it('throws when dist-tags.latest is missing', async () => {
    const config = await startRegistry(() => ({
      status: 200,
      body: { name: 'x', versions: {} },
    }));
    await expect(fetchManifest(config, '@gl3-plugins/plugin-a')).rejects.toThrow(/latest/);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npx vitest run test/registry.test.ts
```

Expected: cannot resolve `../src/registry.js`.

- [ ] **Step 3: Write the client**

Create `src/registry.ts`:

```ts
export type Manifest = {
  version: string;
  description?: string;
  keywords?: string[];
  license?: string;
  readme?: string;
};

export type RegistryConfig = {
  url: string;
  username: string;
  token: string;
  timeoutMs: number;
};

type ManifestDocument = {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, { description?: string; keywords?: string[]; license?: string }>;
  readme?: string;
};

/**
 * Fetches a package manifest from the GL3 registry.
 *
 * HTTP Basic, not a bearer token: Verdaccio rejects a raw `gl3_` token in an
 * Authorization: Bearer header with a 401, and the only bearer it accepts is a
 * session JWT obtained by logging in -- which would add a login round-trip and
 * an expiry model for nothing this needs.
 *
 * Resolves null for 404. A curated package that has not been published yet is a
 * normal state, not a failure, and must not be confused with one: every other
 * non-2xx throws so that a revoked credential surfaces loudly instead of quietly
 * emptying the website's catalogue.
 */
export async function fetchManifest(
  config: RegistryConfig,
  packageName: string
): Promise<Manifest | null> {
  const auth = Buffer.from(`${config.username}:${config.token}`).toString('base64');

  const response = await fetch(`${config.url}/${encodeURIComponent(packageName)}`, {
    headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`registry responded ${response.status} for ${packageName}`);
  }

  const doc = (await response.json()) as ManifestDocument;
  const latest = doc['dist-tags']?.latest;
  if (latest === undefined) {
    throw new Error(`registry returned no dist-tags.latest for ${packageName}`);
  }

  const version = doc.versions?.[latest];
  if (version === undefined) {
    throw new Error(`registry returned no version ${latest} for ${packageName}`);
  }

  return {
    version: latest,
    ...(version.description !== undefined ? { description: version.description } : {}),
    ...(version.keywords !== undefined ? { keywords: version.keywords } : {}),
    ...(version.license !== undefined ? { license: version.license } : {}),
    ...(doc.readme !== undefined ? { readme: doc.readme } : {}),
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npx vitest run test/registry.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts test/registry.test.ts
git commit -m "feat: registry manifest client over HTTP Basic

Basic rather than bearer: Verdaccio 401s a raw gl3_ token in an
Authorization: Bearer header, and the only bearer it accepts is a session
JWT that would cost a login round-trip and an expiry model.

404 resolves null because a curated-but-unpublished package is normal;
every other non-2xx throws so a revoked credential cannot quietly empty
the catalogue."
```

---

## Task 4: Refresher

**Files:**
- Create: `src/catalog-refresh.ts`
- Test: `test/catalog-refresh.test.ts` (create)

**Interfaces:**
- Consumes: `Manifest` from Task 3; the `catalog_packages` table from Task 1.
- Produces: `RefreshResult` (`{refreshed: number; failed: number; skipped: number}`), `refreshCatalog(db, fetch, logger): Promise<RefreshResult>`, `startCatalogRefresh(db, fetch, logger, intervalMs): () => void`. The `fetch` parameter has type `(packageName: string) => Promise<Manifest | null>`.

- [ ] **Step 1: Write the failing tests**

Create `test/catalog-refresh.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { refreshCatalog } from '../src/catalog-refresh.js';
import { silentLogger } from '../src/log.js';
import type { Manifest } from '../src/registry.js';
import { setupHarness } from './helpers.js';

const h = setupHarness();

const MANIFEST: Manifest = {
  version: '1.2.3',
  description: 'a paid plugin',
  keywords: ['gl3'],
  license: 'UNLICENSED',
  readme: '# plugin-a',
};

async function catalogue(pkg: string, position = 1) {
  await h.call('/v1/admin/catalog', {
    method: 'POST',
    body: JSON.stringify({ package: pkg, position }),
  });
}

function row(pkg: string) {
  return h.db
    .query<{
      version: string | null;
      description: string | null;
      fetched_at: Date | null;
      fetch_error: string | null;
    }>(
      'select version, description, fetched_at, fetch_error from catalog_packages where package = $1',
      [pkg]
    )
    .then((r) => r.rows[0]);
}

describe('refreshCatalog', () => {
  it('writes the manifest fields and stamps the fetch', async () => {
    await catalogue('@gl3-plugins/a');

    const result = await refreshCatalog(h.db, async () => MANIFEST, silentLogger());

    expect(result).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    const r = await row('@gl3-plugins/a');
    expect(r.version).toBe('1.2.3');
    expect(r.description).toBe('a paid plugin');
    expect(r.fetch_error).toBeNull();
    expect(r.fetched_at).not.toBeNull();
  });

  it('keeps the last good value when a fetch throws', async () => {
    // A registry outage must never blank the website's catalogue.
    await catalogue('@gl3-plugins/a');
    await refreshCatalog(h.db, async () => MANIFEST, silentLogger());
    const before = await row('@gl3-plugins/a');

    const result = await refreshCatalog(
      h.db,
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      silentLogger()
    );

    expect(result).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    const after = await row('@gl3-plugins/a');
    expect(after.version).toBe('1.2.3');
    expect(after.description).toBe('a paid plugin');
    expect(after.fetch_error).toMatch(/ECONNREFUSED/);
    // fetched_at is deliberately NOT stamped on failure, so staleness keeps
    // growing instead of being masked by a fresh timestamp on a failed attempt.
    expect(after.fetched_at?.getTime()).toBe(before.fetched_at?.getTime());
  });

  it('records not_published for a 404 without clearing cached values', async () => {
    await catalogue('@gl3-plugins/a');
    await refreshCatalog(h.db, async () => MANIFEST, silentLogger());

    const result = await refreshCatalog(h.db, async () => null, silentLogger());

    expect(result).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    const r = await row('@gl3-plugins/a');
    expect(r.version).toBe('1.2.3');
    expect(r.fetch_error).toBe('not_published');
  });

  it('one failure does not abort the pass', async () => {
    await catalogue('@gl3-plugins/a', 1);
    await catalogue('@gl3-plugins/b', 2);
    await catalogue('@gl3-plugins/c', 3);

    const result = await refreshCatalog(
      h.db,
      async (name) => {
        if (name === '@gl3-plugins/b') {
          throw new Error('boom');
        }
        return MANIFEST;
      },
      silentLogger()
    );

    expect(result).toEqual({ refreshed: 2, failed: 1, skipped: 0 });
    expect((await row('@gl3-plugins/c')).version).toBe('1.2.3');
  });

  it('never throws, even when every fetch fails', async () => {
    // It runs from a timer callback; an escaping rejection would be unhandled.
    await catalogue('@gl3-plugins/a');

    await expect(
      refreshCatalog(
        h.db,
        async () => {
          throw new Error('boom');
        },
        silentLogger()
      )
    ).resolves.toEqual({ refreshed: 0, failed: 1, skipped: 0 });
  });

  it('is a no-op on an empty catalogue', async () => {
    expect(await refreshCatalog(h.db, async () => MANIFEST, silentLogger())).toEqual({
      refreshed: 0,
      failed: 0,
      skipped: 0,
    });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test?host=/var/run/postgresql" npx vitest run test/catalog-refresh.test.ts
```

Expected: cannot resolve `../src/catalog-refresh.js`.

- [ ] **Step 3: Write the refresher**

Create `src/catalog-refresh.ts`:

```ts
import type { Db } from './db.js';
import type { Logger } from './log.js';
import type { Manifest } from './registry.js';

export type FetchManifest = (packageName: string) => Promise<Manifest | null>;

export type RefreshResult = {
  /** Packages whose metadata was updated from a manifest. */
  refreshed: number;
  /** Packages whose fetch threw. Cached values were left alone. */
  failed: number;
  /** Packages the registry does not have yet (404). */
  skipped: number;
};

/**
 * One pass over every catalogued package.
 *
 * Never throws. It runs from a timer callback, where an escaping rejection
 * would be an unhandled rejection and take the process down -- and a registry
 * being briefly unreachable is routine, not fatal.
 *
 * A failed fetch never clears a previously good value: the website showing
 * slightly old metadata is always better than it showing none.
 */
export async function refreshCatalog(
  db: Db,
  fetchManifest: FetchManifest,
  logger: Logger
): Promise<RefreshResult> {
  const { rows } = await db.query<{ package: string }>(
    'select package from catalog_packages order by position, package'
  );

  const result: RefreshResult = { refreshed: 0, failed: 0, skipped: 0 };

  for (const { package: packageName } of rows) {
    try {
      const manifest = await fetchManifest(packageName);

      if (manifest === null) {
        // Curated but not published yet. Keep whatever we had.
        await db.query(
          "update catalog_packages set fetch_error = 'not_published' where package = $1",
          [packageName]
        );
        result.skipped += 1;
        continue;
      }

      await db.query(
        `update catalog_packages
            set version = $2,
                description = $3,
                keywords = $4,
                license = $5,
                readme = $6,
                fetched_at = now(),
                fetch_error = null
          where package = $1`,
        [
          packageName,
          manifest.version,
          manifest.description ?? null,
          manifest.keywords ?? null,
          manifest.license ?? null,
          manifest.readme ?? null,
        ]
      );
      result.refreshed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('catalog refresh failed', { package: packageName, err: message });

      // fetched_at is deliberately left alone: stamping it here would reset the
      // staleness clock on a failed attempt and hide the outage from the site.
      await db
        .query('update catalog_packages set fetch_error = $2 where package = $1', [
          packageName,
          message,
        ])
        .catch(() => {});
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Runs `refreshCatalog` on an interval, plus one pass shortly after boot.
 *
 * The first pass is scheduled rather than awaited so a slow or unreachable
 * registry cannot delay the service becoming healthy. Returns a stop function.
 */
export function startCatalogRefresh(
  db: Db,
  fetchManifest: FetchManifest,
  logger: Logger,
  intervalMs: number
): () => void {
  const pass = (): void => {
    void refreshCatalog(db, fetchManifest, logger).then((result) => {
      logger.info('catalog refreshed', result);
    });
  };

  const first = setTimeout(pass, 1000);
  const timer = setInterval(pass, intervalMs);

  // Neither timer should hold the process open at shutdown.
  first.unref();
  timer.unref();

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test?host=/var/run/postgresql" npx vitest run
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/catalog-refresh.ts test/catalog-refresh.test.ts
git commit -m "feat: background catalogue refresher

Last-known-good on every failure path, and fetched_at is not stamped when
a fetch throws so staleness keeps growing rather than being masked. The
pass never throws because it runs from a timer callback."
```

---

## Task 5: Configuration, wiring, and documentation

**Files:**
- Modify: `src/env.ts`, `src/index.ts`, `README.md`
- Test: `test/env.test.ts` (create)

**Interfaces:**
- Consumes: `fetchManifest`/`RegistryConfig` from Task 3, `startCatalogRefresh` from Task 4.
- Produces: nothing later tasks depend on. This is the last task.

- [ ] **Step 1: Write the failing test**

Create `test/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';

const BASE = {
  DATABASE_URL: 'postgres:///x',
  INTERNAL_API_KEY: 'k'.repeat(32),
};

describe('loadEnv registry settings', () => {
  it('leaves the registry unconfigured when nothing is set', () => {
    const env = loadEnv(BASE);
    expect(env.REGISTRY_URL).toBeUndefined();
    expect(env.REGISTRY_REFRESH_MS).toBe(900_000);
  });

  it('accepts a full registry configuration', () => {
    const env = loadEnv({
      ...BASE,
      REGISTRY_URL: 'https://npm.gl3.dev',
      REGISTRY_USERNAME: 'storefront',
      REGISTRY_TOKEN: 'gl3_abc',
      REGISTRY_REFRESH_MS: '60000',
    });
    expect(env.REGISTRY_URL).toBe('https://npm.gl3.dev');
    expect(env.REGISTRY_USERNAME).toBe('storefront');
    expect(env.REGISTRY_REFRESH_MS).toBe(60_000);
  });

  it('strips a trailing slash from the registry url', () => {
    // The client joins with '/', so a trailing slash would produce '//name'.
    const env = loadEnv({ ...BASE, REGISTRY_URL: 'https://npm.gl3.dev/' });
    expect(env.REGISTRY_URL).toBe('https://npm.gl3.dev');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx vitest run test/env.test.ts
```

Expected: `REGISTRY_REFRESH_MS` is undefined rather than 900000.

- [ ] **Step 3: Extend the environment schema**

In `src/env.ts`, add to the zod object:

```ts
  // The website's catalogue reads package metadata from the registry using the
  // storefront service account. All four are optional: every deployment before
  // the catalogue existed sets none of them, and an unset registry simply means
  // the refresher never starts.
  REGISTRY_URL: z
    .string()
    .min(1)
    .transform((value) => value.replace(/\/+$/, ''))
    .optional(),
  REGISTRY_USERNAME: z.string().min(1).optional(),
  REGISTRY_TOKEN: z.string().min(1).optional(),
  REGISTRY_REFRESH_MS: z.coerce.number().int().positive().default(900_000),
```

- [ ] **Step 4: Wire the refresher into the entrypoint**

Replace `src/index.ts` with:

```ts
import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { startCatalogRefresh } from './catalog-refresh.js';
import { createPool } from './db.js';
import { loadEnv } from './env.js';
import { createLogger } from './log.js';
import { fetchManifest } from './registry.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const db = createPool(env.DATABASE_URL);
const app = createApp({
  db,
  internalApiKey: env.INTERNAL_API_KEY,
  logger,
  catalogStaleMs: 2 * env.REGISTRY_REFRESH_MS,
});

// A pool error with no listener is an unhandled 'error' event, which takes the
// process down -- and a dropped backend connection is routine, not fatal.
db.on('error', (err) => logger.error('idle client error', { err: err.message }));

// The refresher is started here rather than inside createApp so the app factory
// stays pure: tests construct an app without a timer starting behind them.
let stopCatalogRefresh: () => void = () => {};

if (
  env.REGISTRY_URL !== undefined &&
  env.REGISTRY_USERNAME !== undefined &&
  env.REGISTRY_TOKEN !== undefined
) {
  const registry = {
    url: env.REGISTRY_URL,
    username: env.REGISTRY_USERNAME,
    token: env.REGISTRY_TOKEN,
    // Longer than the auth plugin's own 5s timeout: the registry answers this
    // call by calling back into this service, so a slow inner hop should
    // surface as the plugin's failure rather than an ambiguous outer one.
    timeoutMs: 10_000,
  };

  stopCatalogRefresh = startCatalogRefresh(
    db,
    (packageName) => fetchManifest(registry, packageName),
    logger,
    env.REGISTRY_REFRESH_MS
  );
  logger.info('catalog refresh enabled', { intervalMs: env.REGISTRY_REFRESH_MS });
} else {
  logger.warn('catalog refresh disabled: REGISTRY_URL, REGISTRY_USERNAME or REGISTRY_TOKEN unset');
}

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('listening', { port: info.port });
});

async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  stopCatalogRefresh();
  server.close(() => {
    db.end().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

- [ ] **Step 5: Document the routes**

In `README.md`, add a row to the Admin endpoint table:

```markdown
| POST | `/v1/admin/catalog` | `{package, position}` | `201` / `400` |
| DELETE | `/v1/admin/catalog/:package` | — | `200` / `404` |
```

and a new section after the endpoint tables:

````markdown
### Catalogue

The website's package directory. `POST /v1/admin/catalog` curates the list — the
`position` you give it is the only value you own; everything else is a cache of the
package's registry manifest, refreshed on a timer.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/v1/catalog/packages` | the ordered list, without readmes |
| GET | `/v1/catalog/packages/:package` | one package, including its readme |

The catalogue spans both GL3 scopes: `@gl3-plugins/*`, which premium unlocks, and the
public `@gl3/*`, which is the SDK developers build against. `paid` in the response is
derived from the scope. Scoped names in a path must be URL-encoded — an unencoded slash
reads as two path segments and never matches the route.

`stale` is true when the last fetch failed, or has not happened, or is older than two
refresh intervals. A failed refresh never clears cached metadata, so an unreachable
registry shows as stale data rather than an empty site.

Refreshing needs the storefront service account from the metadata-access runbook below,
and the refresher only starts when all three of `REGISTRY_URL`, `REGISTRY_USERNAME` and
`REGISTRY_TOKEN` are set:

```bash
curl -sX POST localhost:8080/v1/admin/catalog \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"package":"@gl3-plugins/plugin-a","position":10}'
```
````

Add to the deployment variables table:

```markdown
| `REGISTRY_URL` | no | Registry base URL, e.g. `https://npm.gl3.dev`. Unset disables catalogue refresh |
| `REGISTRY_USERNAME` | no | The storefront service account |
| `REGISTRY_TOKEN` | no | Its `gl3_` token, sent as HTTP Basic |
| `REGISTRY_REFRESH_MS` | no | Default 900000 (15 minutes) |
```

- [ ] **Step 6: Run everything**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test?host=/var/run/postgresql" npx vitest run
npm run typecheck
npm run build
```

Expected: all green, and the build produces `dist/` without errors.

- [ ] **Step 7: Commit**

```bash
git add src/env.ts src/index.ts test/env.test.ts README.md
git commit -m "feat: wire the catalogue refresher and document it

All four REGISTRY_* variables are optional because every deployment
predating the catalogue sets none of them. The refresher starts in
index.ts rather than createApp so the app factory stays pure and tests
never start a timer."
```

---

## Manual verification after deploy

Not a code task. The unit tests never touch a real registry, so this is the only check that the credential and the wiring actually work together.

- [ ] Run the migration as its own step: `node dist/migrate.js`.
- [ ] Deploy with the three `REGISTRY_*` values set to the storefront service account.
- [ ] Add a package: `POST /v1/admin/catalog {"package":"@gl3/plugin-sdk","position":1}`.
- [ ] Within a minute, `GET /v1/catalog/packages` shows it with a version and `stale: false`.
- [ ] Confirm the credential is still metadata-only: `npm pack @gl3-plugins/<something> --registry <url>` with the storefront token must fail 403. Use an isolated npm cache (`--cache /tmp/x`) or a previously downloaded tarball will produce a false pass.
