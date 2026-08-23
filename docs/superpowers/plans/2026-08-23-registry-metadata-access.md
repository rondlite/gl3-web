# Metadata-Only Registry Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a credential read `@gl3-plugins/*` package metadata from the GL3 registry while being hard-denied every tarball in that scope.

**Architecture:** Verdaccio guards the manifest route and the tarball route with the same `can('access')` middleware, and the auth plugin receives no signal distinguishing them. The middleware already derives `req.params.filename`, which Express populates only on the tarball route, then discards it — so the fix is to forward it as a `tarball` boolean through `Auth.allow_access` to the plugin, which passes it to store-api. Store-api gains an `access` column on `entitlements` (`download` | `metadata`) and denies metadata-only grants on tarball requests.

**Tech Stack:** store-api — Node 22, TypeScript 5.8 ESM, Hono 4.7, zod 3.24, `pg` 8.14, Vitest 3.1 against real Postgres. Fork — pnpm workspace, TypeScript, Vitest + supertest. Plugin — CommonJS, Node 24, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-23-registry-metadata-access-design.md`

## Global Constraints

- **Two repositories.** Tasks 1, 2 and 5a are in `rondlite/gl3-store-api`. Tasks 3, 4 and 5b are in `rondlite/verdaccio`. Neither is checked out in this repo — clone each before starting its tasks.
- **Ship order is store-api first, fork second.** Store-api's change is backwards compatible with the current plugin; the reverse is not true. Do not merge Task 3/4 before Tasks 1/2 are deployed.
- **The column is `access`, never `kind`.** `packages.ts` already exports `PackagePattern.kind` with values `'exact' | 'scope'`; a second unrelated `kind` in the same file is a trap.
- **Allowed `access` values:** exactly `'download'` and `'metadata'`. Default `'download'`.
- **Exact error codes:** `not_entitled`, `metadata_only`, `invalid_access`. Tests assert on these strings.
- **Absent `tarball` means `true`.** Fail closed everywhere — in the route default, in the plugin's `!== false`, and in the tests.
- **Staff roles keep unconditional download.** `STAFF_ROLES = ['admin', 'gl3-dev-lead']` in `src/service.ts` bypasses entitlements entirely so publishers are not blind to what they published. Metadata-only must not weaken this.
- **Migrations are append-only.** Never edit `001_init.sql`. New file, next number.
- **store-api is ESM.** Relative imports carry a `.js` suffix even for `.ts` sources (`./packages.js`).
- **Tests need a real Postgres.** `createdb gl3_store_test`, then run with `TEST_DATABASE_URL="postgres:///gl3_store_test"`. No mocks — the thing under test is mostly SQL. `fileParallelism: false` is already set in `vitest.config.ts`; do not change it.

---

## File Structure

**`rondlite/gl3-store-api`**

| File | Change | Responsibility |
| --- | --- | --- |
| `migrations/002_entitlement_access.sql` | create | Adds the `access` column and its check constraint |
| `src/service.ts` | modify | `grantEntitlement` stores `access`; `authorizePackage` resolves a decision instead of a boolean |
| `src/app.ts` | modify | Grant route validates `access`; authorize route accepts `tarball` and maps the decision to a status |
| `test/entitlements.test.ts` | modify | Owns `authorize-package` and the grant route already; all new cases land here |
| `README.md` | modify | Endpoint tables, the access model, and the service-account runbook |

**`rondlite/verdaccio`**

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/middleware/src/middlewares/allow.ts` | modify | Forwards `tarball: Boolean(filename)` |
| `packages/core/core/src/plugin-utils.ts` | modify | `AuthPluginPackage.tarball?: boolean` |
| `packages/core/types/src/configuration.ts` | modify | `AllowAccess.tarball?: boolean` |
| `packages/auth/src/auth.ts` | modify | Carries `tarball` into the object handed to plugins |
| `packages/middleware/test/allow.spec.ts` | modify | Asserts the flag is set only on filename routes |
| `packages/plugins/verdaccio-auth-gl3/index.js` | modify | Forwards the flag to store-api, fail-closed |
| `packages/plugins/verdaccio-auth-gl3/test/allow-access.test.js` | create | Covers the fail-closed coercion |
| `packages/plugins/verdaccio-auth-gl3/package.json` | modify | Adds a `test` script |

---

## Task 1: Store the access level on an entitlement

**Files:**
- Create: `migrations/002_entitlement_access.sql`
- Modify: `src/service.ts` (`grantEntitlement`, around lines 167-187)
- Modify: `src/app.ts` (grant route, around lines 184-221)
- Test: `test/entitlements.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `EntitlementAccess = 'download' | 'metadata'` exported from `src/service.ts`; `grantEntitlement(db, { userId, package, access?, source?, expiresAt? })`; `POST /v1/admin/users/:userId/entitlements` accepting an optional `access` field and returning `400 {"error":"invalid_access"}` for anything else.

- [ ] **Step 1: Write the failing tests**

Append to `test/entitlements.test.ts`. The file already defines `seedUser`, `authorize` and `grant` helpers at the top — reuse them, do not redefine.

```ts
describe('entitlement access level', () => {
  it('defaults a grant to download', async () => {
    const userId = await seedUser();
    expect((await grant(userId, { package: '@gl3-plugins/plugin-a' })).status).toBe(201);

    const { rows } = await h.db.query<{ access: string }>('select access from entitlements');
    expect(rows).toEqual([{ access: 'download' }]);
  });

  it('stores an explicit metadata grant', async () => {
    const userId = await seedUser();
    const res = await grant(userId, { package: '@gl3-plugins/*', access: 'metadata' });
    expect(res.status).toBe(201);

    const { rows } = await h.db.query<{ access: string }>('select access from entitlements');
    expect(rows).toEqual([{ access: 'metadata' }]);
  });

  it('rejects an access level that is neither download nor metadata', async () => {
    const userId = await seedUser();
    const res = await grant(userId, { package: '@gl3-plugins/plugin-a', access: 'sideways' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_access' });
  });

  it('re-granting changes the access level in place', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/plugin-a', access: 'metadata' });
    await grant(userId, { package: '@gl3-plugins/plugin-a', access: 'download' });

    const { rows } = await h.db.query<{ access: string }>('select access from entitlements');
    expect(rows).toEqual([{ access: 'download' }]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test" npx vitest run test/entitlements.test.ts
```

Expected: failures reading `column "access" does not exist`.

- [ ] **Step 3: Add the migration**

Create `migrations/002_entitlement_access.sql`:

```sql
-- Separates an entitlement that may download tarballs from one that may only read
-- package metadata. The storefront reads the plugin catalogue with a 'metadata'
-- grant, so a leak of its token cannot yield a single paid tarball.
--
-- Named 'access' rather than 'kind' because packages.ts already exports
-- PackagePattern.kind ('exact' | 'scope') and service.ts imports it -- two
-- unrelated things called kind in one file is a trap.
--
-- Existing rows become 'download', which is what they already meant.
alter table entitlements add column access text not null default 'download'
  check (access in ('download', 'metadata'));
```

- [ ] **Step 4: Teach `grantEntitlement` about it**

In `src/service.ts`, add the exported type above `grantEntitlement`:

```ts
export type EntitlementAccess = 'download' | 'metadata';
```

Then replace `grantEntitlement` entirely:

```ts
export async function grantEntitlement(
  db: Db,
  input: {
    userId: string;
    package: string;
    access?: EntitlementAccess;
    source?: string;
    expiresAt?: Date;
  }
): Promise<void> {
  if (parsePattern(input.package) === null) {
    throw new Error(`not a grantable package pattern: ${input.package}`);
  }

  // Re-granting a previously revoked entitlement should reinstate it, which is
  // why this is an upsert rather than an insert that conflicts. `access` is part
  // of the update set: re-granting at a different level must move the existing
  // row rather than silently keep the old level.
  await db.query(
    `insert into entitlements (user_id, package, access, source, expires_at)
          values ($1, $2, $3, $4, $5)
     on conflict (user_id, package) do update
            set revoked_at = null,
                access = excluded.access,
                source = excluded.source,
                expires_at = excluded.expires_at,
                granted_at = now()`,
    [
      input.userId,
      input.package,
      input.access ?? 'download',
      input.source ?? 'manual',
      input.expiresAt ?? null,
    ]
  );
}
```

- [ ] **Step 5: Accept and validate it at the route**

In `src/app.ts`, extend the grant route's schema — keep `access` as a plain string so the rejection is ours and carries the documented error code, matching how `package` is already hand-checked:

```ts
      zValidator(
        'json',
        z.object({
          package: z.string().min(1),
          access: z.string().min(1).optional(),
          source: z.string().min(1).optional(),
          expiresAt: z.coerce.date().optional(),
        })
      ),
```

Immediately after the existing `parsePattern` guard, add:

```ts
      if (body.access !== undefined && body.access !== 'download' && body.access !== 'metadata') {
        return c.json(
          { error: 'invalid_access', message: 'expected "download" or "metadata"' },
          400
        );
      }
```

And pass it through in the `grantEntitlement` call, following the existing conditional-spread style:

```ts
        await grantEntitlement(db, {
          userId: c.req.param('userId'),
          package: body.package,
          ...(body.access !== undefined ? { access: body.access as EntitlementAccess } : {}),
          ...(body.source !== undefined ? { source: body.source } : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        });
```

Add `EntitlementAccess` to the existing type-only import from `./service.js`:

```ts
import {
  authenticate,
  authorizePackage,
  createTokenForUser,
  createUser,
  type EntitlementAccess,
  grantEntitlement,
  revokeEntitlement,
  revokeToken,
} from './service.js';
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test" npx vitest run
npm run typecheck
```

Expected: the whole suite passes, including every pre-existing test unchanged.

- [ ] **Step 7: Commit**

```bash
git add migrations/002_entitlement_access.sql src/service.ts src/app.ts test/entitlements.test.ts
git commit -m "feat: record an access level on entitlements

download or metadata, defaulting to download so existing rows keep their
meaning. Named access rather than kind because packages.ts already exports
PackagePattern.kind."
```

---

## Task 2: Deny metadata-only grants on tarball requests

**Files:**
- Modify: `src/service.ts` (`authorizePackage`, around lines 81-108)
- Modify: `src/app.ts` (authorize route, around lines 107-122)
- Test: `test/entitlements.test.ts`

**Interfaces:**
- Consumes: `EntitlementAccess` and the `access` column from Task 1.
- Produces: `PackageDecision = 'ok' | 'metadata_only' | 'not_entitled'` exported from `src/service.ts`; `authorizePackage(db, { userId, package, tarball })` returning a `PackageDecision` — **note this is a breaking change from the current `Promise<boolean>`**; `POST /v1/auth/authorize-package` accepting an optional `tarball` boolean.

- [ ] **Step 1: Write the failing tests**

The existing `authorize` helper in `test/entitlements.test.ts` sends no `tarball` field. Leave it exactly as it is — the omitted-field case depends on it — and add a second helper beside it:

```ts
function authorizeTarball(userId: string, pkg: string, tarball: boolean) {
  return h.call('/v1/auth/authorize-package', {
    method: 'POST',
    body: JSON.stringify({ userId, package: pkg, tarball }),
  });
}
```

Then append:

```ts
describe('metadata-only entitlements', () => {
  it('allows a manifest read', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*', access: 'metadata' });

    const res = await authorizeTarball(userId, '@gl3-plugins/plugin-a', false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('denies a tarball download', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*', access: 'metadata' });

    const res = await authorizeTarball(userId, '@gl3-plugins/plugin-a', true);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'metadata_only' });
  });

  it('denies when the tarball field is missing entirely', async () => {
    // Fail closed. An unpatched registry sends no flag, and guessing "manifest"
    // there would hand every paid tarball to the storefront key.
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*', access: 'metadata' });

    const res = await authorize(userId, '@gl3-plugins/plugin-a');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'metadata_only' });
  });

  it('leaves a download entitlement able to fetch tarballs', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*' });

    expect((await authorizeTarball(userId, '@gl3-plugins/plugin-a', true)).status).toBe(200);
  });

  it('lets a download grant win over a metadata grant on the same package', async () => {
    // grantingPatterns matches the exact name and the wildcard, and the primary
    // key is (user_id, package), so a user can hold one of each. The more
    // permissive must win or buying a plugin would be undone by a metadata grant.
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*', access: 'metadata' });
    await grant(userId, { package: '@gl3-plugins/plugin-a', access: 'download' });

    expect((await authorizeTarball(userId, '@gl3-plugins/plugin-a', true)).status).toBe(200);
  });

  it('keeps staff downloading without any entitlement row', async () => {
    const userId = await seedUser('publisher');
    await h.db.query("insert into user_roles (user_id, role) values ($1, 'gl3-dev-lead')", [
      userId,
    ]);

    expect((await authorizeTarball(userId, '@gl3-plugins/plugin-a', true)).status).toBe(200);
  });

  it('denies a metadata grant that has been revoked', async () => {
    const userId = await seedUser();
    await grant(userId, { package: '@gl3-plugins/*', access: 'metadata' });
    await h.call(`/v1/admin/users/${userId}/entitlements`, {
      method: 'DELETE',
      body: JSON.stringify({ package: '@gl3-plugins/*' }),
    });

    const res = await authorizeTarball(userId, '@gl3-plugins/plugin-a', false);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'not_entitled' });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test" npx vitest run test/entitlements.test.ts
```

Expected: the metadata-denial cases return 200 instead of 403, because nothing consults `access` yet.

- [ ] **Step 3: Rewrite `authorizePackage` to return a decision**

Replace the whole function in `src/service.ts`. Keep the `STAFF_ROLES` constant and its comment directly above, untouched.

```ts
export type PackageDecision = 'ok' | 'metadata_only' | 'not_entitled';

/**
 * Resolves what a user may do with a package right now.
 *
 * Order matters. Staff bypass entitlements entirely, and a download grant beats
 * a metadata one: `grantingPatterns` matches both the exact name and the scope
 * wildcard, so a user can hold one row of each and the permissive one has to win.
 *
 * An `access` value that is neither string matches neither branch and lands on
 * `not_entitled` -- unknown means denied, not granted.
 */
export async function authorizePackage(
  db: Db,
  input: { userId: string; package: string; tarball: boolean }
): Promise<PackageDecision> {
  const { rows } = await db.query<{ staff: boolean; download: boolean; metadata: boolean }>(
    `select
       exists (
         select 1 from user_roles r
          where r.user_id = u.id
            and r.role = any($3::text[])
       ) as staff,
       exists (
         select 1 from entitlements e
          where e.user_id = u.id
            and e.package = any($2::text[])
            and e.revoked_at is null
            and (e.expires_at is null or e.expires_at > now())
            and e.access = 'download'
       ) as download,
       exists (
         select 1 from entitlements e
          where e.user_id = u.id
            and e.package = any($2::text[])
            and e.revoked_at is null
            and (e.expires_at is null or e.expires_at > now())
            and e.access = 'metadata'
       ) as metadata
       from users u
      where u.id = $1
        and u.disabled_at is null
      limit 1`,
    [input.userId, grantingPatterns(input.package), STAFF_ROLES]
  );

  const row = rows[0];
  if (!row) {
    return 'not_entitled';
  }
  if (row.staff || row.download) {
    return 'ok';
  }
  if (row.metadata) {
    return input.tarball ? 'metadata_only' : 'ok';
  }
  return 'not_entitled';
}
```

- [ ] **Step 4: Map the decision at the route**

In `src/app.ts`, replace the authorize-package handler body. The out-of-scope guard above it stays exactly as it is.

```ts
  app.post(
    '/v1/auth/authorize-package',
    zValidator(
      'json',
      z.object({
        userId: z.string().min(1),
        package: z.string().min(1),
        tarball: z.boolean().optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid('json');

      // A package outside the sellable scope should never have reached this
      // endpoint; the plugin defers those to the registry's own config rules.
      if (!isSellablePackage(body.package)) {
        return c.json({ error: 'not_entitled', reason: 'out_of_scope' }, 403);
      }

      // Absent means tarball. A registry too old to send the flag must not be
      // read as "this is only a manifest request".
      const decision = await authorizePackage(db, {
        userId: body.userId,
        package: body.package,
        tarball: body.tarball ?? true,
      });

      if (decision === 'ok') {
        return c.json({ ok: true });
      }
      if (decision === 'metadata_only') {
        return c.json({ error: 'metadata_only' }, 403);
      }
      return c.json({ error: 'not_entitled' }, 403);
    }
  );
```

- [ ] **Step 5: Run the whole suite and typecheck**

```bash
TEST_DATABASE_URL="postgres:///gl3_store_test" npx vitest run
npm run typecheck
```

Expected: all green. `test/auth.test.ts` and `test/errors.test.ts` must be untouched and passing — that is the regression signal for paying customers.

- [ ] **Step 6: Commit**

```bash
git add src/service.ts src/app.ts test/entitlements.test.ts
git commit -m "feat: deny metadata-only entitlements on tarball requests

authorize-package takes an optional tarball flag defaulting to true, so a
registry that does not send it fails closed. Staff and download grants are
unaffected."
```

---

## Task 3: Carry the tarball flag through the registry core

**Files:**
- Modify: `packages/middleware/src/middlewares/allow.ts`
- Modify: `packages/core/core/src/plugin-utils.ts:129-133`
- Modify: `packages/core/types/src/configuration.ts:350-354`
- Modify: `packages/auth/src/auth.ts:261-271`
- Test: `packages/middleware/test/allow.spec.ts`

**Interfaces:**
- Consumes: nothing — this is the fork repo, independent of Tasks 1 and 2.
- Produces: `AuthPluginPackage.tarball?: boolean` and `AllowAccess.tarball?: boolean`; auth plugins' `allow_access(user, pkg, cb)` receives `pkg.tarball === true` on tarball routes and `false` otherwise.

- [ ] **Step 1: Write the failing test**

Append to `packages/middleware/test/allow.spec.ts`, matching the existing supertest idiom in that file:

```ts
test('should mark a filename route as a tarball request', async () => {
  let seen: any;
  const can = allow({
    allow_access: (params, remote, cb) => {
      seen = params;
      return cb(null, true);
    },
  });
  const app = getApp([]);
  app.get('/:package/-/:filename', can('access'), (req, res) => {
    res.status(HTTP_STATUS.OK).json({});
  });

  await request(app).get('/react/-/react-0.0.1.tgz').expect(HTTP_STATUS.OK);
  expect(seen.tarball).toBe(true);
  expect(seen.packageName).toBe('react');
});

test('should not mark a manifest route as a tarball request', async () => {
  let seen: any;
  const can = allow({
    allow_access: (params, remote, cb) => {
      seen = params;
      return cb(null, true);
    },
  });
  const app = getApp([]);
  app.get('/:package', can('access'), (req, res) => {
    res.status(HTTP_STATUS.OK).json({});
  });

  await request(app).get('/react').expect(HTTP_STATUS.OK);
  expect(seen.tarball).toBe(false);
});
```

Add `expect` to the existing vitest import at the top of the file:

```ts
import { expect, test } from 'vitest';
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm --filter @verdaccio/middleware test -- allow.spec.ts
```

Expected: `expected undefined to be true` — the flag is not forwarded yet.

- [ ] **Step 3: Forward the flag from the middleware**

In `packages/middleware/src/middlewares/allow.ts`, `filename` is already computed a few lines above. Change only the call:

```ts
      auth['allow_' + action](
        { packageName, packageVersion, tarball: Boolean(filename) },
        remote_user,
        function (error, allowed): void {
```

Leave the rest of the callback untouched.

- [ ] **Step 4: Widen the two types**

`packages/core/core/src/plugin-utils.ts`:

```ts
export interface AuthPluginPackage {
  packageName: string;
  packageVersion?: string;
  tag?: string;
  /**
   * True when the request is for a tarball rather than a manifest. Verdaccio
   * guards both routes with the same `access` action, so this is the only thing
   * telling an auth plugin which one it is being asked about.
   */
  tarball?: boolean;
}
```

`packages/core/types/src/configuration.ts`:

```ts
export interface AllowAccess {
  name: string;
  version?: string;
  tag?: string;
  /** True when the request is for a tarball rather than a manifest. */
  tarball?: boolean;
}
```

- [ ] **Step 5: Carry it into the object handed to plugins**

In `packages/auth/src/auth.ts`, change the destructure and the merge in `allow_access`:

```ts
  public allow_access(
    { packageName, packageVersion, tarball }: pluginUtils.AuthPluginPackage,
    user: RemoteUser,
    callback: pluginUtils.AccessCallback
  ): void {
    const plugins = this.plugins.slice(0);
    // `tarball` is assigned after the config spec, not before: a stray `tarball`
    // key in a config.yaml `packages:` block would otherwise override a security
    // decision made from the request.
    const pkg = Object.assign(
      { name: packageName, version: packageVersion },
      authUtils.getMatchedPackagesSpec(packageName, this.config.packages),
      { tarball: tarball === true }
    ) as AllowAccess & PackageAccess;
```

Leave `allow_publish` (line ~312) and `allow_unpublish` (line ~378) alone. They share the middleware factory and will now receive the field, which is inert — no bundled plugin reads it, and publish tarball uploads reporting `tarball: true` is both true and unused.

- [ ] **Step 6: Run the tests and typecheck**

```bash
pnpm --filter @verdaccio/middleware test
pnpm --filter @verdaccio/auth test
pnpm --filter @verdaccio/api test
pnpm --filter @verdaccio/web test
```

Expected: all pass. The three other `allow_access` call sites — `packages/web/src/api/package.ts:45`, `packages/web/src/api/search.ts:18`, `packages/api/src/v1/search.ts:45` — pass no `filename` and now land on `tarball: false`, which is correct for all three and needs no edit.

- [ ] **Step 7: Commit**

```bash
git add packages/middleware/src/middlewares/allow.ts \
        packages/middleware/test/allow.spec.ts \
        packages/core/core/src/plugin-utils.ts \
        packages/core/types/src/configuration.ts \
        packages/auth/src/auth.ts
git commit -m "feat(auth): tell auth plugins whether a request is for a tarball

The manifest and tarball routes share can('access'), so a plugin cannot
distinguish them. The allow middleware already derives req.params.filename,
which is set only on the tarball route, and then drops it -- forward it."
```

---

## Task 4: Forward the flag from the GL3 plugin, fail closed

**Files:**
- Modify: `packages/plugins/verdaccio-auth-gl3/index.js` (`allow_access`)
- Modify: `packages/plugins/verdaccio-auth-gl3/package.json`
- Test: `packages/plugins/verdaccio-auth-gl3/test/allow-access.test.js` (create)

**Interfaces:**
- Consumes: `pkg.tarball` from Task 3.
- Produces: `POST /v1/auth/authorize-package` request bodies of shape `{ userId, package, tarball }`, consumed by Task 2's route.

- [ ] **Step 1: Add a test script**

The plugin is CommonJS on Node 24 with no tests today. Add to `packages/plugins/verdaccio-auth-gl3/package.json`:

```json
  "scripts": {
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test**

Create `packages/plugins/verdaccio-auth-gl3/test/allow-access.test.js`:

```js
const assert = require('node:assert/strict');
const { test } = require('node:test');

const factory = require('../index.js');

const silentLogger = { error: () => {}, debug: () => {}, trace: () => {}, warn: () => {} };

// Captures the body the plugin POSTs to store-api and always answers 200, so
// each test asserts on what was sent rather than on the verdict.
function pluginWithCapture() {
  const sent = [];
  const plugin = factory(
    { api_url: 'http://store.test', internal_api_key: 'k'.repeat(32) },
    { logger: silentLogger }
  );
  plugin._post = async (path, body) => {
    sent.push({ path, body });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  return { plugin, sent };
}

const user = { real_groups: ['uid:usr_1'] };

test('reports a tarball request as a tarball', async () => {
  const { plugin, sent } = pluginWithCapture();

  await new Promise((resolve) =>
    plugin.allow_access(user, { name: '@gl3-plugins/plugin-a', tarball: true }, resolve)
  );

  assert.equal(sent[0].body.tarball, true);
});

test('reports a manifest request as not a tarball', async () => {
  const { plugin, sent } = pluginWithCapture();

  await new Promise((resolve) =>
    plugin.allow_access(user, { name: '@gl3-plugins/plugin-a', tarball: false }, resolve)
  );

  assert.equal(sent[0].body.tarball, false);
});

test('treats a missing flag as a tarball', async () => {
  // An unpatched Verdaccio core sends no flag. Reading that as "manifest" would
  // hand every paid tarball to a metadata-only key, so the unknown case is
  // coerced to the restrictive side.
  const { plugin, sent } = pluginWithCapture();

  await new Promise((resolve) =>
    plugin.allow_access(user, { name: '@gl3-plugins/plugin-a' }, resolve)
  );

  assert.equal(sent[0].body.tarball, true);
});
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
cd packages/plugins/verdaccio-auth-gl3 && npm test
```

Expected: the first two fail with `undefined !== true` / `undefined !== false` — no `tarball` key is sent yet.

- [ ] **Step 4: Forward the flag**

In `packages/plugins/verdaccio-auth-gl3/index.js`, inside `allow_access`, change the single `_post` call:

```js
    // `!== false` rather than `=== true`: against an unpatched Verdaccio core
    // pkg.tarball is undefined, and reading that as "not a tarball" would hand
    // every paid tarball to a metadata-only key. Coercing the unknown case to
    // true breaks the metadata key loudly instead of leaking the catalogue.
    this._post('/authorize-package', {
      userId,
      package: pkg.name,
      tarball: pkg.tarball !== false,
    })
```

Nothing else in the file changes — the scope filter, the `publicPackages` bypass, the anonymous defer, and the hard-403 branch all stay as they are.

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd packages/plugins/verdaccio-auth-gl3 && npm test
```

Expected: three passing tests.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/verdaccio-auth-gl3/index.js \
        packages/plugins/verdaccio-auth-gl3/package.json \
        packages/plugins/verdaccio-auth-gl3/test/allow-access.test.js
git commit -m "feat(auth-gl3): send the tarball flag to store-api

Coerces an absent flag to true so an unpatched core fails closed: the
metadata key breaks loudly rather than the paid catalogue leaking."
```

---

## Task 5: Document the access model and the service account

**Files:**
- Modify: `README.md` in `rondlite/gl3-store-api` (5a)
- Modify: `packages/plugins/verdaccio-auth-gl3/README.md` in `rondlite/verdaccio` if one exists; otherwise the header comment in `index.js` (5b)

**Interfaces:**
- Consumes: everything from Tasks 1-4. Produces no code.

- [ ] **Step 1: Update the store-api endpoint table**

In `README.md`, the "Called by the registry plugin" table's `authorize-package` row becomes:

```markdown
| POST | `/v1/auth/authorize-package` | `{userId, package, tarball?}` | `200 {ok:true}` / `403 {error:"not_entitled"}` / `403 {error:"metadata_only"}` |
```

And the admin entitlement row:

```markdown
| POST | `/v1/admin/users/:userId/entitlements` | `{package, access?, source?, expiresAt?}` | `201` / `400` / `404` |
```

- [ ] **Step 2: Document the access model**

Add after the existing paragraph explaining the two allowed `package` shapes:

```markdown
An entitlement also carries an `access` level, `download` (the default) or
`metadata`. A `metadata` entitlement reads manifests but is refused tarballs, which
is what lets the storefront list the catalogue with a credential that cannot download
a single paid plugin. `tarball` on `/v1/auth/authorize-package` defaults to **true**
when absent, so a registry too old to send it fails closed.

Resolution order is: staff roles first (they bypass entitlements entirely so a
publisher is not blind to what they just published), then any `download` grant, then
`metadata`. A `download` grant beats a `metadata` one, because `grantingPatterns`
matches both the exact name and the scope wildcard and a user can hold one row of
each.
```

- [ ] **Step 3: Add the service-account runbook**

Add to the Deployment section:

````markdown
### The storefront metadata account

The storefront reads the plugin catalogue through an account that can see every
manifest in the paid scope and download none of them.

```bash
KEY=$(grep INTERNAL_API_KEY .env | cut -d= -f2)

# roles MUST be empty: a staff role bypasses entitlements entirely and would
# give this token every tarball.
curl -sX POST localhost:8080/v1/admin/users \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"username":"storefront","email":"storefront@gl3.dev","roles":[]}'

curl -sX POST localhost:8080/v1/admin/users/usr_xxx/tokens \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"catalogue"}'

curl -sX POST localhost:8080/v1/admin/users/usr_xxx/entitlements \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"package":"@gl3-plugins/*","access":"metadata","source":"storefront"}'
```

The token is returned once. It becomes `REGISTRY_TOKEN` alongside
`REGISTRY_USERNAME=storefront` wherever the catalogue is fetched.

Verify it before trusting it — the second call must fail:

```bash
npm view @gl3-plugins/plugin-a --registry https://npm.gl3.dev   # succeeds
npm pack @gl3-plugins/plugin-a --registry https://npm.gl3.dev   # 403 metadata_only
```
````

- [ ] **Step 4: Note the requirement on the plugin side**

In `rondlite/verdaccio`, add to the header comment block of
`packages/plugins/verdaccio-auth-gl3/index.js`, after the existing two-responsibility list:

```js
// Requires a Verdaccio core that forwards `pkg.tarball` (allow middleware ->
// Auth.allow_access). Against an older core the flag is absent and every request
// is reported as a tarball, which denies metadata-only entitlements outright.
```

- [ ] **Step 5: Commit both repos**

```bash
# in gl3-store-api
git add README.md
git commit -m "docs: entitlement access levels and the storefront account"

# in verdaccio
git add packages/plugins/verdaccio-auth-gl3/index.js
git commit -m "docs(auth-gl3): note the core version requirement"
```

---

## Deployment

Not a code task, but the order is part of the design and skipping it opens the hole this plan closes.

- [ ] Deploy store-api (Tasks 1, 2) and run `node dist/migrate.js` as its own step. Migrations are deliberately not run on boot, so a rolling deploy cannot have replicas racing to alter the schema.
- [ ] Confirm the existing registry still authenticates and installs normally. The old plugin sends no `tarball`, that reads as `true`, and `download` entitlements are indifferent to it.
- [ ] Merge the fork (Tasks 3, 4) to `master` and let `.github/workflows/ghcr-publish.yml` build the image. Roll the registry onto it.
- [ ] Create the storefront account (Task 5 Step 3) and run the two-command verification.

Steps 1 and 2 are independently revertible, and no `metadata` entitlement exists in the database until the last step — so there is no window in which the new column changes any existing customer's access.
