# Plugin catalogue in store-api

**Date:** 2026-08-23
**Sub-project:** B of A–E (see "Programme context" in the A spec)
**Repos changed:** `rondlite/gl3-store-api`
**Depends on:** A (metadata-only registry access), shipped and merged
**Status:** approved, not implemented

## Problem

gl3-web needs to display the GL3 package directory: the paid plugins premium unlocks,
and the public packages developers build against. That data lives in the private
registry at `npm.gl3.dev`, which gl3-web has no credential for and should not have one
for — the credential belongs to a server, and gl3-web's server talks to store-api, not
to the registry.

A gave store-api the ability to hold a credential that reads manifests and cannot
download tarballs. Nothing consumes it yet. B is the consumer.

## Goal and non-goals

**Goal:** store-api holds a curated list of package names, keeps a cached copy of each
one's registry metadata refreshed in the background, and serves it to gl3-web.

B is complete when gl3-web can fetch an ordered package list with live metadata over
one authenticated call, and the list survives the registry being unreachable.

**Non-goals**, deliberately deferred:

| Deferred to | What |
| --- | --- |
| D | Stripe checkout, buyer accounts, token delivery |
| E1 | the site itself — rendering, layout, copy |
| E2 | the signed-in storefront area |

B adds no page, no public route, and no rendering. It is a data service.

## Settled by measurement, not assumption

A's spec reasoned about how store-api would authenticate to the registry and left it
open between a session JWT and other options. With A shipped, the question was settled
against a live stack (Verdaccio running the patched `verdaccio-auth-gl3`, store-api on
the published image, a seeded `storefront` account holding a `metadata` entitlement):

| Credential form on `GET /@gl3-plugins/plugin-a` | Result |
| --- | --- |
| Raw `gl3_` token as `Authorization: Bearer` | **401** |
| Verdaccio session JWT as `Authorization: Bearer` | 200 |
| HTTP Basic `storefront:<gl3_token>` | **200** |
| Anonymous | 401 |

And the metadata restriction holds under Basic exactly as designed: the same credential
gets 200 on the manifest, 200 on the abbreviated install manifest, and **403** on
`/@gl3-plugins/plugin-a/-/plugin-a-1.0.0.tgz`, while a `download` entitlement gets 200
on that tarball.

**The client is therefore HTTP Basic.** No login round-trip, no JWT lifetime, no
refresh-before-expiry logic, no dependency on Verdaccio's private web API or on
`web.login` staying enabled. A raw bearer token is not an option — it fails closed at
401, which is the correct failure but not a usable client.

## Rejected alternatives

**Session-JWT client.** Log in at `/-/verdaccio/sec/login`, hold the JWT, refresh it
before expiry. Works, and is the only route to *enumerating* the scope, but B does not
enumerate — it fetches by name from a curated list. The JWT path costs a login step, an
expiry model, and a hard dependency on Verdaccio's private UI API, for nothing B needs.

**Splitting curated rows from cached metadata into two tables.** The relationship is
strictly one-to-one and keyed identically, so the join buys nothing. One table with a
comment marking which columns are curated and which the refresher overwrites is clearer.

**Storing a paid/free flag per package.** Derivable from the scope prefix. Storing it
creates a second source of truth that can disagree with the registry.

**Refresh inside a request.** Forbidden by A's design, not merely undesirable: store-api
fetching from the registry causes the registry to call back into store-api through the
auth plugin, so a request that refreshed inline would wait on itself, against the
plugin's 5-second timeout.

## Design

### 1. Schema

New migration `migrations/003_catalog_packages.sql`:

```sql
-- The package directory the website renders: paid plugins and the public SDK.
--
-- `position` is the only curated column -- it is yours, set through the admin
-- routes. Everything from `version` down is a cache of what the registry last
-- returned, overwritten wholesale by the refresher, and safe to lose.
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

create index catalog_packages_position_idx on catalog_packages (position, package);
```

Ordering is `(position, package)` so a duplicated position still yields a stable,
deterministic list rather than an arbitrary one.

### 2. Package-name validation

`src/packages.ts` currently accepts only `@gl3-plugins/` names, via `parsePattern`
(entitlement patterns) and `isSellablePackage` (a name being authorized). The catalogue
admits both scopes, so B adds a **separate** validator:

```ts
export const PUBLIC_SCOPE = '@gl3/';

const CATALOG_NAME = /^@gl3(-plugins)?\/[a-z0-9][a-z0-9._-]*$/;

/** A package name allowed in the website's catalogue: either GL3 scope. */
export function isCatalogPackage(name: string): boolean {
  return CATALOG_NAME.test(name);
}

/** True for names in the paid scope. See the caveat in the spec. */
export function isPaidPackage(name: string): boolean {
  return name.startsWith(SCOPE);
}
```

The existing entitlement validators are **not** loosened. They are a security boundary:
`isSellablePackage` deciding that `@gl3/plugin-sdk` is authorizable would push public
packages through the entitlement check. B must not touch them, and a test asserts they
still reject `@gl3/*`.

**Caveat on `isPaidPackage`,** recorded because it is an assumption rather than a fact
the registry tells us: Verdaccio's `public_packages` setting can make a name inside
`@gl3-plugins/` free without renaming it. That list is empty today. If it is ever
populated, the derivation stops matching reality and the flag has to come from
configuration or from the registry instead.

### 3. Registry client

`src/registry.ts`, one exported function and no state:

```ts
export type Manifest = {
  version: string;
  description?: string;
  keywords?: string[];
  license?: string;
  readme?: string;
};

/** Fetches a package manifest. Resolves null for 404, throws otherwise. */
export async function fetchManifest(
  config: { url: string; username: string; token: string; timeoutMs: number },
  packageName: string
): Promise<Manifest | null>;
```

It sends `Authorization: Basic base64(username:token)`, requests the full manifest, and
reads `dist-tags.latest` to select the version whose fields it returns. `readme` comes
from the document root, which is where Verdaccio puts the latest one.

A 404 resolves to `null` — a curated name that is not published yet is a normal state,
not an error. Every other non-2xx throws, as does a network failure or a timeout.

The timeout matters and is not arbitrary: the registry answers this call by calling back
into store-api through the auth plugin, which itself has a 5-second timeout. The client
default is **10 seconds**, comfortably longer than the inner call, so a slow inner hop
surfaces as the plugin's own failure rather than as an ambiguous outer timeout.

### 4. Refresher

`src/catalog-refresh.ts`:

```ts
export type RefreshResult = { refreshed: number; failed: number; skipped: number };

/** One pass over every catalogued package. Never throws. */
export async function refreshCatalog(
  db: Db,
  fetch: (packageName: string) => Promise<Manifest | null>,
  logger: Logger
): Promise<RefreshResult>;

/** Starts the interval timer. Returns a stop function. */
export function startCatalogRefresh(
  db: Db,
  fetch: (packageName: string) => Promise<Manifest | null>,
  logger: Logger,
  intervalMs: number
): () => void;
```

The fetch function is a parameter, not an import. That is the seam the tests drive, and
it keeps `refreshCatalog` free of configuration.

Per package:

- **Manifest returned** — write `version`, `description`, `keywords`, `license`,
  `readme`, stamp `fetched_at`, clear `fetch_error`.
- **`null` (404)** — leave the cached columns alone, stamp `fetched_at`, set
  `fetch_error` to `not_published`.
- **Throw** — leave the cached columns alone, leave `fetched_at` alone, set
  `fetch_error` to the error message.

**Last-known-good is the rule.** A registry outage must never blank the website's
catalogue, so a failed fetch never clears a previously good value. `fetched_at` is
deliberately not stamped on a thrown error, so staleness keeps growing and the condition
stays visible instead of being masked by a fresh timestamp on a failed attempt.

One package's failure never aborts the pass; each is caught individually and counted.
`refreshCatalog` never throws, so a rejection cannot escape into an unhandled timer
callback and kill the process.

The timer runs the first pass shortly after boot rather than synchronously during
startup, so a slow or unreachable registry cannot delay the service becoming healthy.
`unref()` is set on the interval so it never holds the process open during shutdown.

### 5. Configuration

`src/env.ts` gains four **optional** variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `REGISTRY_URL` | — | e.g. `https://npm.gl3.dev`, no trailing slash |
| `REGISTRY_USERNAME` | — | the storefront service account |
| `REGISTRY_TOKEN` | — | its `gl3_` token, sent via HTTP Basic |
| `REGISTRY_REFRESH_MS` | 900000 | 15 minutes |

All four optional is a requirement, not a convenience: every store-api deployment today
sets none of them, and B must not break any of them. When `REGISTRY_URL`,
`REGISTRY_USERNAME` or `REGISTRY_TOKEN` is missing, the refresher does not start and
logs once at boot saying so. The catalogue routes keep working and serve whatever is in
the table.

This also keeps the test suite off the network by default.

### 6. Routes

All behind the existing `INTERNAL_API_KEY` middleware. store-api gains **no** public
route in B: gl3-web's server is the only caller, and it holds the key.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/v1/catalog/packages` | — | `200 {packages: [...]}` |
| GET | `/v1/catalog/packages/:package` | — | `200 {...}` / `404` |
| POST | `/v1/admin/catalog` | `{package, position}` | `201` / `400 invalid_package` |
| DELETE | `/v1/admin/catalog/:package` | — | `200` / `404` |

A list item:

```json
{
  "package": "@gl3-plugins/plugin-a",
  "paid": true,
  "position": 10,
  "version": "1.0.0",
  "description": "…",
  "keywords": ["gl3", "plugin"],
  "license": "UNLICENSED",
  "fetchedAt": "2026-08-23T19:49:22.995Z",
  "stale": false
}
```

The list **omits `readme`**; the single-package route includes it. A landing page draws
a grid of cards from the list, and shipping every readme to render a grid is waste.

`stale` is true when `fetch_error` is set, or when `fetched_at` is null, or when
`fetched_at` is older than twice `REGISTRY_REFRESH_MS`. Two intervals rather than one so
a single missed pass is not reported as a problem. It is computed at read time, never
stored — a stored flag would itself go stale.

`POST /v1/admin/catalog` upserts on `package`, so it both adds and repositions.

The scoped `:package` path parameter must be URL-encoded. Verified against the repo's
Hono 4.7:

| Request path | `c.req.param('package')` |
| --- | --- |
| `/v1/catalog/packages/@gl3-plugins%2Fplugin-a` | `@gl3-plugins/plugin-a` |
| `/v1/catalog/packages/%40gl3-plugins%2Fplugin-a` | `@gl3-plugins/plugin-a` |
| `/v1/catalog/packages/@gl3-plugins/plugin-a` | **404, no route match** |

So Hono decodes the parameter and no manual decoding is needed, but an unencoded slash
never reaches the handler at all — it reads as two path segments. gl3-web must
`encodeURIComponent` the name, and E1's client is where that will be easy to forget.
The handler validates the decoded value with `isCatalogPackage` and 400s on anything
else.

### 7. Wiring

`createApp` takes the catalogue routes as part of its existing shape. The refresher is
started in `src/index.ts`, not inside `createApp` — the app factory stays pure so tests
construct it without a timer starting. `index.ts` calls the returned stop function on
SIGTERM alongside the existing shutdown.

## Testing

Real Postgres, no mocks, `fileParallelism: false`, matching the existing suite. New file
`test/catalog.test.ts`.

**Refresher**, driving `refreshCatalog` with a stub fetch:

| Case | Expected |
| --- | --- |
| manifest returned | fields written, `fetched_at` stamped, `fetch_error` null |
| fetch throws | previous values intact, `fetched_at` unchanged, `fetch_error` set |
| fetch returns null (404) | previous values intact, `fetch_error` = `not_published` |
| one of three packages throws | other two still refreshed; result counts 2/1/0 |
| never-fetched package | nulls, `stale` true |

**Routes:**

| Case | Expected |
| --- | --- |
| list ordering | by `position`, then `package` |
| list omits readme, detail includes it | — |
| `paid` derivation | true for `@gl3-plugins/*`, false for `@gl3/*` |
| `stale` | true past two intervals or on `fetch_error` |
| POST with `@gl3/plugin-sdk` | 201 — both scopes allowed |
| POST with `lodash` | 400 `invalid_package` |
| POST twice | upserts, repositions, no duplicate row |
| DELETE unknown package | 404 |

**Regression, and the one that matters most:** `isSellablePackage('@gl3/plugin-sdk')`
and `parsePattern('@gl3/*')` must both still reject. B widens what the *catalogue*
accepts and must not widen what the *entitlement check* accepts. Every existing test
must pass unchanged.

## Rollout

1. Deploy store-api with the migration run as its own step, as always. With no
   `REGISTRY_*` variables set, nothing changes: the refresher logs that it is disabled
   and the catalogue is empty.
2. Create the storefront service account per A's runbook if it does not exist, and set
   `REGISTRY_URL`, `REGISTRY_USERNAME`, `REGISTRY_TOKEN`.
3. Add packages with `POST /v1/admin/catalog` and confirm `GET /v1/catalog/packages`
   shows them with `stale: false` after the first pass.

Every step is independently revertible, and unsetting the `REGISTRY_*` variables at any
point stops the refresher without affecting anything else.

## Programme note

Recorded because it emerged while scoping B and changes E: **gl3-web is GL3's actual
website, not only a storefront.** The catalogue therefore lists the public `@gl3/*`
scope alongside the paid one, because the SDK is something developers need to find, not
something they buy. E1's job is a website whose shop is one part, rather than a shop
with pages attached.
