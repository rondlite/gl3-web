# Final whole-branch review — metadata-only registry access

**Reviewer:** senior code review, single pass by one reviewer (no subagents dispatched).
**Scope:** `gl3-store-api` `6a78286..198512b` (4 commits) and `verdaccio` `1cdc16a40..0deb781fb` (3 commits).
**Authority:** `docs/superpowers/specs/2026-08-23-registry-metadata-access-design.md`.
**Read-only:** verification used `git log`, `grep`, and file reads only. Neither working tree, index, HEAD, nor branch state was mutated in either repo. No test suites were re-run.

---

## Strengths

**The security property holds, and I checked it rather than assuming it.** The design rests
entirely on one claim — "`req.params.filename` is populated only on the tarball route" — so I
went after it directly:

- `PACKAGE_API_ENDPOINTS` (`/home/dlite/verdaccio/packages/middleware/src/middlewares/api_urls.ts:23-26`)
  defines exactly two `can('access')` routes: `get_package_by_version = '/:package{/:version}'`
  and `get_package_tarball = '/:package/-/:filename'`. Only the second carries `:filename`.
- `storage.getTarball` has exactly **one** call site in the whole repo outside test helpers:
  `/home/dlite/verdaccio/packages/api/src/package.ts:68`, inside that route. Nothing in
  `packages/web` streams a tarball — it only rewrites `dist.tarball` URLs to point back at the
  guarded API route (`packages/web/src/api/package.ts:72-74`).
- The other `:filename` route, `PUBLISH_API_ENDPOINTS.remove_tarball`, is guarded by
  `can('unpublish')`, not `access`.
- Scoped names do not escape: `encodeScopePackage` (`packages/api/src/index.ts:65`) collapses
  `@scope/name` into a single `:package` segment, so `/@gl3-plugins%2fplugin-a/-/plugin-a-1.0.0.tgz`
  still matches the three-segment tarball route and still yields a `filename`.
- `reqUtils.paramToString` returns `''` for an absent param, not the string `'undefined'`
  (`packages/core/core/src/req-utils.ts:8-10`), so `Boolean(filename)` genuinely lands on `false`
  for manifests. That is a real trap this could have fallen into.

I could not construct a request shape in which a `metadata` entitlement yields tarball bytes.

**The `Auth.allow_access` ordering reasoning is correct.** `Object.assign` copies into a fresh
object literal, so `this.config.packages` is never mutated; the config spec is second and
`{ tarball: tarball === true }` third, so a stray `tarball:` key under a `config.yaml`
`packages:` block cannot override the request-derived value. There is also no key collision
with the builtin fallback, which reads `pkg[action]` i.e. `pkg['access']`
(`packages/auth/src/utils.ts:180`) — `tarball` shadows nothing.

**The publish/unpublish blast radius is smaller than the spec predicted, in the good direction.**
`Auth.allow_publish` (`auth.ts:380`) and `Auth.allow_unpublish` (`auth.ts:315`) destructure only
`{ packageName, packageVersion }`, so the new field is dropped at the `Auth` layer and never
reaches any publish plugin at all. Genuinely inert, not merely harmless.

**The "denial must throw" invariant is preserved everywhere it matters.** The plugin's non-200
branch still constructs an `Error` with `status = 403` and calls `callback(err)`
(`verdaccio-auth-gl3/index.js:204-206`). The three `callback(null, false)` defers — out-of-scope,
`publicPackages`, anonymous — are untouched and are all correct places to defer. The new
`tarball` field is confined to the request body and changes no control flow in the plugin.

**Rollout is safe in both directions, not just the documented one.** The plan only claims
store-api-first is safe. It is also safe fork-first: the old route schema was a plain
`z.object({ userId, package })`, and zod strips unknown keys rather than rejecting, so an early
plugin sending `tarball` against un-migrated store-api degrades silently to today's behaviour.
That removes the sharpest edge from a mis-ordered deploy. Worth recording in the runbook.

**The migration is genuinely non-breaking.** Additive column, constant default, PG 11+ fast-default
path (no table rewrite), existing rows keep exactly the meaning they had. The runner
(`src/migrate.ts`) wraps each file in its own transaction behind an advisory lock and records it
in `schema_migrations`, so the non-idempotent `add column` is safe.

**The `download`-beats-`metadata` rule is right, and for the stated reason.** `grantingPatterns`
returns `[exactName, '@gl3-plugins/*']` and the PK is `(user_id, package)`, so a user can hold one
row of each; the resolution order in `authorizePackage` makes the permissive one win. The old
query's semantics are preserved exactly for missing, disabled, and unentitled users.

**Tests exercise real behaviour on the store-api side.** Real Postgres, real Hono routes, truncate
between tests (`test/helpers.ts:40-42`) — so the bare `select access from entitlements` assertions
are sound. The controller's mutation check on `!== false` is the right kind of evidence and it
landed.

**The fork diff is minimal and upstreamable.** 8 files, +123/-5, of which the security-relevant
core change is a single line. Both type additions are optional and documented. This would be a
reasonable upstream PR as written.

---

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

**I-1. `metadata_only` is unobservable, defeating a stated design goal.**

Spec line 222: *"`metadata_only` is a distinct code from `not_entitled` so a misconfigured key is
diagnosable from logs rather than indistinguishable from an unpaid customer."* As implemented it
is not diagnosable from anywhere:

- `/home/dlite/gl3-store-api/src/app.ts:131-137` returns the code but logs nothing.
- `/home/dlite/gl3-store-api/src/log.ts:11-13` — request logging is documented as *"the method,
  path and status only, never headers or bodies"*. So both denials log identically as
  `POST /v1/auth/authorize-package 403`.
- `/home/dlite/verdaccio/packages/plugins/verdaccio-auth-gl3/index.js:196-207` never reads the
  response body on a non-200; it substitutes its own message
  `user is not entitled to package <name>`. The code dies at the plugin boundary and never
  reaches the npm client either.

The distinction currently costs code and buys nothing. Why it matters: the failure mode this was
built for — a storefront key silently misconfigured, or a version skew making every request read
as a tarball — is exactly the one you would diagnose from logs, and it presents as an ordinary
unpaid-customer 403.

Fix (cheap, both sides): log the decision in the `metadata_only` branch of the route; and in the
plugin, `await res.json().catch(() => null)` on the non-200 path and include the returned `error`
in the log line and the thrown message.

**I-2. Nothing tests `Auth.allow_access`'s coercion or the load-bearing merge ordering.**

`@verdaccio/auth` is reported as 71 passing, *identical to baseline* — no new test. I confirmed
by grep that `tarball` appears nowhere under `packages/auth/test/`. The two new middleware tests
pass a bare object literal as `auth` (`allow({ allow_access: ... })`), so they bypass the `Auth`
class entirely.

That means a regression which moves `{ tarball: tarball === true }` **above**
`getMatchedPackagesSpec` — the one thing the spec calls "load-bearing" (spec:126-129) — passes
every suite in both repos. So would dropping the `=== true` coercion.

Fix: one test in `packages/auth/test` that calls `auth.allow_access({ packageName, tarball: true })`
against a stub plugin and asserts the plugin saw `tarball === true`, plus a second with a
`config.packages` entry carrying a stray `tarball: false` asserting the request value still wins.

**I-3. The new middleware tests declare their own routes instead of the registered ones.**

`packages/middleware/test/allow.spec.ts:135` and `:152` hand-write `'/:package/-/:filename'` and
`'/:package'`. Those are copies of `PACKAGE_API_ENDPOINTS`, not references to it. If upstream
renames the param or reshapes `get_package_tarball`, the entire security property breaks while
both new tests stay green — they would be testing a route that no longer exists.

Fix: import `PACKAGE_API_ENDPOINTS` from `@verdaccio/middleware` and register the routes from the
constants. Stronger still, and cheap given `@verdaccio/api` already has a 143-test suite: one
integration test there that requests a real tarball URL through the real router and asserts the
auth plugin was handed `tarball: true`.

**I-4. Absent `tarball` fails closed across a *version* skew, but not across a *coding* mistake.**

Direct answer to the review question. `Auth.allow_access` writes `{ tarball: tarball === true }`,
which converts "the caller did not tell me" into `false` — and the plugin reads `false` as
"manifest, allow". So the plugin's `!== false` guard is neutralised *inside* the patched core; it
only ever fires against an unpatched one.

Nothing is wrong today: I checked all three other `allow_access` callers
(`packages/web/src/api/package.ts:45`, `packages/web/src/api/search.ts:18`,
`packages/api/src/v1/search.ts:45`) and all three are genuinely metadata paths, exactly as the
spec claims. But `tarball?: boolean` is declared optional on `AuthPluginPackage`, so a future
caller — plausibly an upstream one, since this is meant to be upstreamed — that guards something
byte-yielding and omits `filename` is silently granted to metadata keys, with no type error and
no test failure.

Options, in order of preference:
1. Record the invariant where it can be seen: a comment on `AuthPluginPackage.tarball` stating
   that any `allow_access` caller which can yield package *bytes* must pass a truthy `tarball`,
   and that omission is read as "manifest".
2. Stricter: propagate `undefined` (`...(tarball === undefined ? {} : { tarball })`) and let the
   plugin's `!== false` be the single fail-closed rule. This is strictly safer, and the cost is
   bounded — a metadata key would then be refused by the web UI package list and `/-/v1/search`,
   neither of which B uses. Worth considering, but it is a real behavioural trade-off the spec
   made deliberately, so I am not asking for it as a merge blocker.

### Minor (Nice to Have)

**M-1.** `/home/dlite/gl3-store-api/README.md:185` — `npm pack ... # 403 metadata_only`. The client
will never see that string; per I-1 the plugin replaces it with
`user is not entitled to package @gl3-plugins/plugin-a`. Reword to something like
`# 403 (store-api logs metadata_only)` once I-1 lands.

**M-2.** Re-grant footgun, undocumented. `access` is in the upsert's update set with a default of
`download`, so `POST /v1/admin/users/<storefront>/entitlements {"package":"@gl3-plugins/*"}` —
no `access` field — silently promotes the metadata key to full download. The in-place update is
deliberate and correct; the *default on re-grant* is the trap. One warning line in the runbook
section of README.md.

**M-3.** Nothing warns when a `metadata` grant is issued to a user who holds a staff role — the
precise misconfiguration the spec calls fatal (spec:196-202) and the runbook shouts about. The
grant route already has the user id; a `logger.warn`, or a 400, would close the loop cheaply.

**M-4.** `migrations/002_entitlement_access.sql` — `ADD COLUMN ... CHECK` takes ACCESS EXCLUSIVE
and triggers a constraint-validation scan even though the fast-default path avoids a rewrite.
Negligible on `entitlements` (one row per user per package) and it runs as its own deploy step,
so this is fine as written. Worth knowing the `ADD CONSTRAINT ... NOT VALID` + `VALIDATE` split
exists if the table ever grows.

**M-5.** `src/service.ts` — the `download` and `metadata` EXISTS subqueries are identical but for
the literal. Acceptable (deferred finding 3). If you want it collapsed, a single subquery
returning `bool_or(access = 'download')` / `bool_or(access = 'metadata')` is both DRYer and one
scan rather than two.

**M-6. Spec inaccuracy (you asked to be challenged).** Spec:130-136 says `allow_publish` and
`allow_unpublish` "will begin receiving the field". They do not — `Auth.allow_publish` and
`Auth.allow_unpublish` destructure only `{ packageName, packageVersion }`, so the field is
discarded before any publish plugin sees it. The conclusion ("intentional and inert") is right;
the mechanism described is wrong. Also "Publish tarball uploads will report `tarball: true`" is
not observable by any plugin.

**M-7.** README's "How auth works end to end" step 3 still describes the authorize call without
mentioning the tarball flag. The access-model paragraph added below covers it, so this is
polish only.

**M-8.** Spec:78-87 (the web-API enumeration argument) is **accurate** — I verified
`packages/web/src/api/user.ts:29-61` does let a `gl3_` token obtain a Verdaccio-signed web JWT via
`/-/verdaccio/sec/login`, and the spec explicitly acknowledges that path and its costs rather than
claiming it is impossible. Recorded because it looks like a hole on a fast read and is not one.
No action.

---

## Deferred minors triage

1. **Invalid-`access` test asserts no row absence** — **accept.** The route returns before
   `grantEntitlement` is reached; the assertion would be testing the test. Not worth a line.
2. **`'download'|'metadata'` in three layers** — **accept.** They are not duplication of the same
   concern: the check constraint is the backstop against any future non-route writer, the type is
   compile-time, the route guard exists only to produce the documented `invalid_access` code.
   Collapsing to a zod enum would change the error body and break the contract test.
3. **Identical EXISTS subqueries** — **accept**, see M-5. Optional single-subquery rewrite.
4. **5 of 7 Task-2 tests were not genuinely red** — **accept as a fact, but it is why I-2 and I-3
   matter.** The suite's *coverage* is fine; its *regression-detection* value is weaker than the
   count suggests, and the two places with no coverage at all (I-2, I-3) are the two most
   security-critical lines in the branch.
5. **Plugin harness overrides private `_post`** — **accept.** Without a fetch interceptor there is
   no cleaner seam, and the alternative (a real HTTP stub) buys little for three assertions about
   a request body. Worth noting the harness therefore never exercises the real `_post` or the
   non-200 denial path.

---

## Recommendations

1. **Fix I-1, I-2, I-3 before merge.** Together they are perhaps 30 lines: a log line and a body
   read, one auth-layer test, and swapping two string literals for imported constants. All three
   protect properties the spec itself designates as load-bearing.
2. **Write down the `tarball` invariant next to the type** (I-4, option 1) — cheap insurance for a
   change intended to go upstream, where future callers will not have read this spec.
3. **Add the reverse-order safety note to the runbook.** The branch is safer than documented
   (zod strips the unknown key), and knowing that turns a mis-ordered deploy from an incident
   into a shrug.
4. **Process observation, offered because you asked.** The plan was detailed enough that
   implementers largely transcribed it — which is why several tests came through verbatim,
   including the two structural gaps in I-2/I-3 that were present in the plan itself
   (plan:514-548, and no auth-layer test specified in Task 3 Step 1). A plan that specifies test
   *bodies* inherits full responsibility for test *coverage*; specifying the invariant to pin and
   letting the implementer choose the seam would likely have caught both.
5. **Before the service account is created (deploy step 4)**, run the two-command verification in
   the README against a real registry. Every layer here is unit-tested and no test in either repo
   exercises the full npm client → Verdaccio → plugin → store-api path end to end. That manual
   check is currently the only integration evidence the feature works.

---

## Assessment

**Ready to merge?** With fixes.

**Reasoning:** The security property is real and I could not break it — the discriminator is
sound, the merge ordering is correct, denial still throws, and the migration and rollout are safe
in both directions. What is missing is not correctness but *durability*: the two most critical
lines have no test pinning them, and the diagnostic code the spec asks for never reaches a log.
Fix I-1 through I-3 and this merges.
