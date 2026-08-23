# Metadata-only registry access

**Date:** 2026-08-23
**Sub-project:** A of A–E (see "Programme context" below)
**Repos changed:** `rondlite/verdaccio`, `rondlite/gl3-store-api`
**Status:** approved, not implemented

## Problem

The GL3 storefront needs to display the `@gl3-plugins/*` catalogue: name, version,
description, keywords, readme. That data lives in the private Verdaccio registry at
`npm.gl3.dev`, and reading it requires a credential.

Any credential that can read those manifests today can also download the paid tarballs.
The registry's authorization hook cannot tell the two apart:

- `packages/api/src/package.ts` guards the manifest route
  (`PACKAGE_API_ENDPOINTS.get_package_by_version`) and the tarball route
  (`get_package_tarball`) with the identical `can('access')` middleware.
- That middleware resolves to `allow_action('access')`
  (`packages/auth/src/utils.ts:163`) and ultimately to
  `Auth.allow_access` (`packages/auth/src/auth.ts:261`), which hands the plugin
  `{ name, version }` and nothing else.

So `verdaccio-auth-gl3` sees the same input for "describe this package" and "give me
this package", and a metadata-only entitlement is unenforceable as the code stands.

The discriminator already exists but is discarded.
`packages/middleware/src/middlewares/allow.ts` computes:

```ts
const filename = reqUtils.paramToString(req.params.filename);
```

`req.params.filename` is populated only on the tarball route. The value is used to
derive `packageVersion` and then dropped.

## Goal and non-goals

**Goal:** a credential can read `@gl3-plugins/*` manifests and is hard-denied every
tarball in that scope.

A is complete when a metadata-entitled token fetches a manifest successfully and
receives a 403 on a tarball, both demonstrated by tests.

**Non-goals**, deliberately deferred:

| Deferred to | What |
| --- | --- |
| B | `catalog_plugins` table, registry enrichment job, `GET /v1/catalog/plugins` |
| D | Stripe checkout, buyer account creation at purchase, token delivery |
| E | the gl3-web site itself |

A adds no catalogue, no public route, and no site.

## Rejected alternatives

**Publish-time push.** Plugin release CI POSTs metadata to store-api; no registry
credential exists at all. Rejected in favour of registry pull, which keeps the registry
the single source of truth for package metadata and needs no change to any plugin
repo's release workflow.

**Trust-based key.** Mint a normal `@gl3-plugins/*` token and rely on store-api only
ever requesting manifests. Rejected: the key leaking or being misused means free
download of every paid plugin, and nothing in the system would prevent or record it.

**Token-level flag instead of an entitlement kind.** The natural reading of "a
meta-only key" is a property of the token. It cannot work. Verdaccio persists only
`name` and `real_groups` into the session token — the reason the backend user id
already has to travel inside the groups array as `uid:<userId>`. Token identity is not
available by the time `allow_access` runs, so the flag would need a second synthetic
group and a second decode path. The entitlement carries the property instead, and the
service account is dedicated 1:1 to the key, which reaches the same place with fewer
moving parts.

**Enumeration via Verdaccio's web API.** `/-/verdaccio/data/packages` filters
per-user through `checkAllow` (`packages/web/src/api/package.ts:45`), which calls
`allow_access({ packageName })` with no `filename` — so under this design a metadata
key would see the full catalogue there. It is nevertheless not the chosen enumeration
path, because `webUIJWTmiddleware` (`packages/auth/src/auth.ts:575`) accepts only a
Verdaccio-signed JWT: it calls `verifyJWTPayload(token, this.config.secret, ...)` and
never falls through to the auth plugins. A `gl3_` token presented there fails
verification and degrades silently to `createAnonymousRemoteUser()`. Enumerating would
require logging in at `/-/verdaccio/sec/login` to obtain a JWT, holding and refreshing
it, and depending on Verdaccio's private UI API and on `web.login` never being set to
`false` (`hasLogin`, `packages/web/src/web-utils.ts:5`). B instead curates package
names in store-api and fetches each manifest by name through the stable npm API.

## Design

### 1. Fork patch — carry the discriminator

`packages/middleware/src/middlewares/allow.ts`, forward the value already in scope:

```ts
auth['allow_' + action](
  { packageName, packageVersion, tarball: Boolean(filename) },
  remote_user,
  function (error, allowed): void { /* unchanged */ }
);
```

Type additions:

- `packages/core/core/src/plugin-utils.ts:129` — `AuthPluginPackage` gains
  `tarball?: boolean`.
- `packages/core/types/src/configuration.ts:350` — `AllowAccess` gains
  `tarball?: boolean`.

`packages/auth/src/auth.ts:261` destructures the field and appends it **after** the
config merge:

```ts
public allow_access(
  { packageName, packageVersion, tarball }: pluginUtils.AuthPluginPackage,
  user: RemoteUser,
  callback: pluginUtils.AccessCallback
): void {
  const plugins = this.plugins.slice(0);
  const pkg = Object.assign(
    { name: packageName, version: packageVersion },
    authUtils.getMatchedPackagesSpec(packageName, this.config.packages),
    { tarball: tarball === true }
  ) as AllowAccess & PackageAccess;
```

The ordering is load-bearing. The current code merges the config spec last, so a
`packages:` block in `config.yaml` carrying a stray `tarball` key would override the
security decision. Assigning it afterwards makes that unreachable.

`allow_publish` (`auth.ts:312`) and `allow_unpublish` (`auth.ts:378`) share the
middleware factory and will begin receiving the field. This is intentional and inert:
`verdaccio-auth-gl3` implements neither hook, and the builtin fallback ignores keys it
does not read. Publish tarball uploads will report `tarball: true`, which nothing
consumes.

The three other `allow_access` call sites are all metadata paths and pass no
`filename`, so they land on `tarball: false` with no change required:

- `packages/web/src/api/package.ts:45`
- `packages/web/src/api/search.ts:18`
- `packages/api/src/v1/search.ts:45`

The fork publishes its own image from `master` via
`.github/workflows/ghcr-publish.yml`, so this ships through an existing pipeline. The
change is narrow and generally useful; write it to be upstreamable rather than as a
private hack.

### 2. Plugin change — fail closed

`packages/plugins/verdaccio-auth-gl3/index.js`, in `allow_access`:

```js
this._post('/authorize-package', {
  userId,
  package: pkg.name,
  tarball: pkg.tarball !== false,
})
```

`!== false` rather than `=== true` is deliberate. If this plugin runs against an
unpatched Verdaccio core, `pkg.tarball` is `undefined`. Treating that as "not a
tarball" would hand every paid tarball to a metadata key. Coercing the unknown case to
`true` breaks the *metadata* key loudly on a version mismatch and leaves paid packages
guarded — the failure lands on the side that costs nothing.

Nothing else in the plugin changes. Scope filtering, the `publicPackages` bypass, the
anonymous-defer branch, and the hard-403-on-not-entitled behaviour are all untouched.

### 3. Store-api — kind on the entitlement

New migration `migrations/002_entitlement_access.sql` — `001_init.sql` is currently
the only one, and the repo's convention is that existing migration files are never
edited:

```sql
alter table entitlements add column access text not null default 'download'
  check (access in ('download', 'metadata'));
```

Every existing row defaults to `download`; current customers are unaffected.

The column is `access`, not `kind`. `packages.ts` already exports
`PackagePattern.kind` with values `'exact' | 'scope'`, and `service.ts` imports it —
two unrelated things called `kind` in one file is a trap. `access` also lines up with
Verdaccio's own `allow_access`.

`POST /v1/admin/users/:userId/entitlements` gains an optional `access`, defaulting to
`download`. A value outside the two allowed strings is a 400, matching how the
existing `package` field rejects shapes other than an exact name or the scope
wildcard.

`POST /v1/auth/authorize-package` gains an optional `tarball` boolean, defaulting to
`true` when absent.

**The staff bypass comes first.** `authorizePackage` already grants every paid package
to the roles in `STAFF_ROLES` (`admin`, `gl3-dev-lead`) with no entitlement row at all,
so that a publisher is not blind to what they just published. Staff have no `access`
value to consult, and metadata-only must not weaken them: staff keep full download
access unconditionally. This is why the storefront service account **must not** hold a
staff role — with one, its metadata entitlement would be bypassed entirely and the key
would download tarballs freely. The account is created with `roles: []`.

Resolution order, first match wins:

| Condition | `tarball` | Result |
| --- | --- | --- |
| user missing or disabled | either | `403 {"error":"not_entitled"}` |
| holds a staff role | either | `200 {"ok":true}` |
| any live matching entitlement with `access = 'download'` | either | `200 {"ok":true}` |
| live matching entitlements, all `access = 'metadata'` | `false` | `200 {"ok":true}` |
| live matching entitlements, all `access = 'metadata'` | `true` | `403 {"error":"metadata_only"}` |
| no live matching entitlement | either | `403 {"error":"not_entitled"}` |

`download` beating `metadata` matters because `grantingPatterns` matches both the
exact name and the scope wildcard, and the primary key is `(user_id, package)` — so
one user can hold an exact-name `download` row and a wildcard `metadata` row at once.
The more permissive of the two wins, as it must, or buying a single plugin would be
undone by a metadata grant.

`metadata_only` is a distinct code from `not_entitled` so a misconfigured key is
diagnosable from logs rather than indistinguishable from an unpaid customer.

An `access` value read from the database matching neither string returns 403, not 500.
Unknown means denied.

### 4. Service account

Operator work through existing admin routes, not code. It belongs in the store-api
runbook:

1. `POST /v1/admin/users` — create `storefront` with `roles: []`. A staff role here
   would bypass the entitlement entirely (see above) and hand the key every tarball.
2. `POST /v1/admin/users/:userId/tokens` — mint its token. The plaintext is returned
   once and never again; only a SHA-256 hash is stored.
3. `POST /v1/admin/users/:userId/entitlements` with
   `{"package": "@gl3-plugins/*", "access": "metadata"}`.

The token and username are consumed by store-api in B as `REGISTRY_TOKEN` and
`REGISTRY_USERNAME`, alongside `REGISTRY_URL`.

### 5. The self-call constraint

Store-api authenticating to the registry produces store-api → Verdaccio → plugin →
store-api. One hop, no recursion, but store-api ends up waiting on itself while the
plugin's outbound call has a 5s timeout (`DEFAULT_TIMEOUT_MS`).

**Constraint on B:** the catalogue refresh runs as a background job with its own
bounded timeout, never inline in a request path. Recorded here because A's design
creates the constraint and B is where it can be violated.

## Testing

**Store-api.** The suite runs against a real Postgres with `fileParallelism: false`
and no mocks; new cases follow that. Everything lands in `test/entitlements.test.ts`,
which already owns `authorize-package` and the grant route:

| Case | Expected |
| --- | --- |
| `metadata` entitlement, `tarball: true` | 403 `metadata_only` |
| `metadata` entitlement, `tarball: false` | 200 |
| `download` entitlement, `tarball: true` | 200 |
| `metadata` entitlement, field omitted | 403 `metadata_only` |
| staff role, no entitlement, `tarball: true` | 200 |
| wildcard `metadata` + exact `download`, `tarball: true` | 200 |
| grant with `access: "sideways"` | 400 `invalid_access` |

The omitted-field case is the fail-closed assertion; the staff case guards the bypass
against regression; the mixed-grant case pins `download` beating `metadata`. Every
existing test must pass unchanged — that is the regression signal that paying
customers were not affected.

**Fork.** A unit test on the allow middleware asserting `tarball` is `true` when
`req.params.filename` is set and `false` when it is not.

## Rollout

Order matters; this is a security change.

1. **Store-api first.** Backwards compatible: the current plugin sends no `tarball`
   field, it defaults to `true`, and `download` entitlements pass regardless of the
   flag.
2. **Fork image and plugin.**
3. **Service account created.**

Safe at every step, because no `metadata` entitlement exists in the database until
step 3. Steps 1 and 2 are independently revertible.

## Programme context

A is the first of five sub-projects behind "a site for GL3". Each gets its own spec.

| | Sub-project | Repos | Depends on |
| --- | --- | --- | --- |
| A | Metadata-only registry access | verdaccio, gl3-store-api | — |
| B | Catalogue in store-api | gl3-store-api | A |
| D | Stripe checkout and buyer provisioning | gl3-store-api | — |
| E1 | Public site | gl3-web | B |
| E2 | Signed-in storefront | gl3-web | D |

Build order: A → B → E1 ships a live site with a real catalogue. Then D → E2 makes it
a storefront.

There is no C. It was scoped as an email-and-password identity subsystem for
store-api and then dropped: buyers sign in with the `gl3_` token they already use for
`npm login`, proxied to the existing `POST /v1/auth/authenticate`. That removes
password hashing, signup, verification, reset, and the email sender store-api does not
have, and it lets D land far sooner. The letters D and E keep their original values so
this document and the discussion behind it stay aligned.

Decisions taken at programme level, recorded here because A is the first spec written:

- **Many games, one store.** There is a single marketplace and an open-ended number of
  independent GL3 deployments run by licensees. A buyer's players belong to that
  buyer's deployment, not to the marketplace and not to its operator. Store-api holds
  no game-player data and no store route ever resolves a game player; the two identity
  systems live in different databases in different services and never join. D creates
  store-side accounts for buyers only — a second identity system deliberately, and a
  boundary that constrains D and E2 rather than an accident of build order.

  One purchase unlocks any number of games. The licence is per buyer, never per
  deployment, so nothing is counted, activated, or registered at install time — the
  existing `@gl3-plugins/*` wildcard entitlement on the buyer's account already
  expresses it exactly, and D adds no licensing machinery of any kind. A buyer's
  single token is what every one of their deployments authenticates with.
- **Buyers sign in with their `gl3_` token, not a password.** The storefront login
  form takes username plus the token already used for `npm login`, and gl3-web's
  server proxies it to store-api's existing `POST /v1/auth/authenticate`, holding the
  result in a session cookie. Store-api gains no end-user auth subsystem at all.

  Token delivery in D is **both**: shown once on the post-checkout page, where
  gl3-web exchanges Stripe's `session_id` for the freshly minted token, and also sent
  by email so closing that tab is not fatal. A buyer who loses it contacts support and
  an operator issues a replacement through the existing admin token routes. There is
  no self-service recovery, by choice — a recovery flow would need an authenticated
  caller, and the only credential is the thing that was lost.

  Two consequences to carry into D. It needs a transactional email sender, which
  store-api does not have — much smaller than the verification-and-reset stack dropped
  with C, but not free. And a `gl3_` token is a long-lived credential, so emailing it
  leaves one sitting in an inbox indefinitely; D should therefore let a signed-in buyer
  mint a replacement and revoke the old one, which the admin token routes already
  support and which a buyer who still holds their token can reach unaided.

- **One SKU for now.** Premium is the whole engine including all plugins, so the
  catalogue is a display list rather than a set of individually purchasable items.
  Entitlement stays the existing `@gl3-plugins/*` wildcard.
- **gl3-web deploys as one container.** VitePress static output served by a Hono
  server that also hosts `/api/*` and holds `INTERNAL_API_KEY`, published as
  `ghcr.io/rondlite/gl3-web`, matching how gl3-server and gl3-store-api already ship.
  Hono rather than Fastify because store-api is Hono 4 + zod + `@hono/node-server`,
  and gl3-web is the only other service that will speak to it.
- **Specs for all five live in the gl3-web repo**, each naming its target repo, so the
  programme reads in one place.
