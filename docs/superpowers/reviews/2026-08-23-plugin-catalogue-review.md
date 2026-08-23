# Final branch review — plugin catalogue (sub-project B)

**Branch:** `feat/plugin-catalogue` in `gl3-store-api`, 8 commits, `40aa258..1ca7d90`
**Reviewed against:** `docs/superpowers/specs/2026-08-23-plugin-catalogue-design.md` (binding) and
`docs/superpowers/plans/2026-08-23-plugin-catalogue.md`
**Method:** full diff read once end to end, then five targeted file reads in the repo to settle
risks I could not resolve from the diff alone (named inline below). Read-only: HEAD, index and
working tree untouched; `git status` was clean before and after. No subagents were used.

---

## Strengths

**The entitlement boundary is genuinely intact, and I verified it rather than taking the diff's
word for it.** `SCOPE`, `EXACT`, `parsePattern`, `isSellablePackage` and `grantingPatterns` in
`src/packages.ts:7-40` are byte-identical to their pre-branch form; the new code is appended
below them. More importantly the new validators cannot leak into the authorization path: grepping
every use of `isCatalogPackage` and `isPaidPackage` across `src/` and `test/` yields exactly two
call sites, `src/app.ts:66` (the presenter's `paid` field) and `src/app.ts:332` (the admin POST
guard). Neither is reachable from `service.ts`, and `service.ts:136,221` still call
`grantingPatterns` and `parsePattern` unchanged. The catalogue table is likewise read by nothing
in the authorization path — `catalog_packages` appears only in the four new service functions and
the refresher.

**The two pinning tests are meaningful, not decorative.** `test/catalog.test.ts` exercises the
boundary through the real HTTP routes (`POST /v1/auth/authorize-package` expecting
`403 out_of_scope`, and `POST /v1/admin/users/:id/entitlements` with `@gl3/*` expecting 400)
rather than calling the validators directly. That means they would catch a widening introduced
anywhere in the chain — a loosened regex, a swapped validator at the call site, a route that
forgot to check — not just an edit to `packages.ts`. This is the right shape for a regression
test on a security boundary.

**The registry credential has no path to a log, a response, or an operator's screen.**
`src/index.ts` logs variable *names* on the disabled path and `{intervalMs}` on the enabled path,
never values. `fetchManifest`'s throw messages carry only an HTTP status and a package name.
The one place error text is persisted is `catalog_packages.fetch_error`, and `presentCatalogRow`
(`src/app.ts:64-75`) deliberately does not include that column in either response shape — so even
if a future error message did carry something sensitive, it does not reach the website. The
service-wide `app.onError` at `src/app.ts:101-114` returns a bare `{error:'internal'}` and keeps
detail in the logs, so an unhandled throw from a catalogue route cannot echo SQL or config either.

**Two deviations from the plan are real improvements, correctly reasoned.** The refresher replaced
the plan's `setInterval` with chained `setTimeout` (`src/catalog-refresh.ts:110-133`), which makes
overlapping passes structurally impossible instead of merely unlikely — the plan's version would
have overlapped as soon as one pass exceeded `intervalMs`, which is reachable with N packages at a
10s timeout each. And the listing query got its own guard (`src/catalog-refresh.ts:33-43`) so a
database blip returns zero counts rather than throwing out of a timer callback; the plan's version
had the listing query outside any try, which was a genuine hole in the "never throws" promise.
Both are the kind of change that should be made against a plan rather than deferred to it.

**Rollout is as safe as the spec claims.** Migration 003 creates one new table and one index on
it — no lock is taken on any existing table, so it is safe to run against a live database ahead
of the deploy, and `src/migrate.ts` applies it in its own transaction behind an advisory lock.
Every existing deployment sets no `REGISTRY_*` variable, and the only consequence is one warn line
at boot; the built-artifact evidence confirms this end to end.

**Testing genuinely avoids mocks where it matters.** `test/registry.test.ts` stands up a real HTTP
server on an ephemeral port and asserts the `Authorization: Basic` header as it arrives over the
wire, which is a materially stronger check than asserting what the client intended to send. The
mutation evidence confirms the ordering, staleness-threshold, last-known-good and guarded-listing
tests all bite.

---

## Issues

### Critical (Must Fix)

None. I attacked the failure paths the design stakes itself on — blanking cached metadata, a
rejection escaping a timer, overlapping passes, a widened entitlement scope, a leaked credential —
and did not find one that holds up.

### Important (Should Fix)

**1. The `:package` path parameter is never validated, contradicting the spec.**
`src/app.ts:347` (DELETE) and `src/app.ts:359` (GET detail) pass `c.req.param('package')` straight
to the service layer. Spec §6 is explicit: "The handler validates the decoded value with
`isCatalogPackage` and 400s on anything else." Neither route does.

This is not a security hole — both service functions use parameterized queries
(`src/service.ts:274,307`), so nothing is injectable, and the only names in the table have already
passed `isCatalogPackage` on the way in. The cost is contract fidelity: a caller sending `lodash`
or a typo gets `404 not_found`, indistinguishable from a well-formed name that simply is not
catalogued. E1's client is where that distinction will matter, and the spec anticipated exactly
that by asking for the 400.

Worth flagging as a **plan defect, not just an implementation one**: the plan's Task 1 Step 7 and
Task 2 Step 4 both specify these handlers verbatim, and both omit the validation the spec
requires. The implementation followed the plan faithfully; the plan silently dropped a spec
requirement. This is the third instance of the pattern you asked me to watch for.

*Fix:* guard both handlers with `isCatalogPackage(c.req.param('package'))` returning the same
`400 invalid_package` body the POST route uses, and add one test per route.

**2. `src/registry.ts:47` — the registry response is type-cast, not validated.**
`const doc = (await response.json()) as ManifestDocument` asserts a shape rather than checking it,
and the extracted fields are handed to `pg` unvalidated. Every other external boundary in this
service is validated with zod, which is already a dependency; this one is not.

Manifest contents are authored by whoever publishes the package, not by the registry, and two
legacy-but-common npm shapes break here:

- `"keywords": "gl3, plugin"` (a string rather than an array) is typed `string[]` but arrives as a
  string, and is written to a `text[]` column at `src/catalog-refresh.ts:62-79`. Postgres rejects
  it with `malformed array literal`. The per-package catch contains the damage — the pass
  continues, the cached values survive, the row goes stale — so the *design promise holds*. But
  that package then fails identically on every subsequent pass, forever, and the operator sees a
  Postgres parse error attributed to a registry fetch, which points at the wrong component.
- `"license": {"type":"MIT","url":"..."}` (the pre-SPDX object form) is typed `string`, and `pg`
  will `JSON.stringify` a plain object bound to a `text` parameter. It stores and serves
  `{"type":"MIT","url":"..."}` as the licence string on the website.

*Fix:* parse `doc` with a zod schema and drop fields that fail their expected type, rather than
asserting. That also converts a permanent silent failure into a clear "registry returned an
unexpected manifest shape" message.

**3. Nothing tests that the catalogue routes require the internal API key.**
The routes *are* protected — `app.use('/v1/*', ...)` at `src/app.ts:127-136` matches them — but
only because it is registered before them, and Hono applies middleware by registration order. The
file relies on that ordering deliberately in the other direction: `/healthz` is registered at
`src/app.ts:116`, above the middleware, precisely so it stays open. So "is this route
authenticated?" is answered by line ordering in a 367-line file, and the existing 401 tests
(`test/auth.test.ts:29-47`) only exercise `/v1/auth/authenticate`.

If someone later moves a route registration above line 127, the catalogue becomes public and every
one of the 73 tests still passes. Given that "store-api gains **no** public route in B" is a
stated design property, and the fix is one test, it should be pinned.

*Fix:* one test calling `/v1/catalog/packages` with `key: null` and asserting 401. The harness
already supports it.

### Minor (Nice to Have)

**4. `src/catalog-refresh.ts:53-57` — the 404 path does not stamp `fetched_at`, but the spec says
it should.** Spec §4 reads: "**`null` (404)** — leave the cached columns alone, stamp
`fetched_at`, set `fetch_error` to `not_published`." The implementation only sets `fetch_error`,
which the built-artifact evidence confirms (`fetched_at` left NULL for both unpublished packages).
The spec is internally inconsistent here — its own Testing table for the same case lists only
"previous values intact, `fetch_error` = `not_published`" — and the plan encoded the non-stamping
variant, so nobody noticed the divergence. No test pins it in either direction.

The API contract is unaffected: `stale` is already true because `fetch_error` is set. The real
difference is diagnostic. Under the spec's behaviour, `fetchedAt` shows when the refresher last
*looked*, which distinguishes "the refresher is running and the package genuinely is not
published" from "the refresher never ran at all". Under the implementation's behaviour, both look
identical from the API. That is a small argument for the spec's version.

*Recommendation:* decide deliberately and make spec, code and a test agree. I lean toward changing
the code to match the spec, for the diagnostic — but either resolution is fine as long as it is
chosen rather than inherited.

**5. `src/app.ts:82` and `src/env.ts:19` both hard-code `900_000`.** `catalogStaleMs = 2 * 900_000`
in the app factory duplicates `REGISTRY_REFRESH_MS`'s default. `index.ts` always passes the real
value so production is consistent, but changing the env default would silently leave the app
factory's default — the one every test runs under — disagreeing with it. Export the default as a
named constant from `env.ts` and use it in both places.

**6. A successful fetch of a manifest without a `readme` clears a cached one.**
`src/catalog-refresh.ts:74` writes `manifest.readme ?? null`, so a manifest that omits the field
blanks a previously good readme. This follows the spec ("overwritten wholesale by the refresher"),
and is correct when a package genuinely removed its readme — but it is worth knowing before E1
builds a detail page on `readme`, because the same path is taken if the registry ever returns a
manifest variant without a root-level `readme`. Not a defect; a consequence to be aware of.

**7. `src/app.ts:62` compares an app-process clock against a database clock.** `stale` is
`Date.now() - fetched_at.getTime() > staleMs`, where `fetched_at` was written by Postgres `now()`.
If the API and database hosts drift apart, the staleness window shifts by the drift. Computing
staleness in SQL would make it single-clock. Low impact at a 30-minute window, but it is a
correctness assumption worth recording.

**8. `src/app.ts:328` accepts any `position` a 32-bit integer column cannot hold.**
`z.number().int()` is unbounded, so `position: 1e15` reaches Postgres and raises `22003`, which
surfaces as `500 {error:'internal'}`. Correctly contained by `app.onError` and admin-only, so this
is tidiness rather than risk: `.min()`/`.max()` on the zod schema would make it a 400.

**9. Shutdown does not wait for an in-flight pass.** `stopCatalogRefresh()` prevents the *next*
pass but returns immediately (`src/catalog-refresh.ts:135-141`), so `db.end()` in the SIGTERM
handler can run while a pass is awaiting a fetch. The subsequent query fails, the per-package
catch swallows it, and one warn line is logged before exit. Harmless, and arguably better than
delaying shutdown by up to the 10s registry timeout — but it means a clean SIGTERM can log a
"catalog refresh failed" line, which an operator may misread as a real failure.

**10. `src/app.ts:8` is a 117-character single-line import** in a file where every other multi-name
import is wrapped. There is no lint or format script in `package.json`, so nothing gates it and it
cannot break CI; it is purely inconsistent with the file around it.

**11. `test/catalog-refresh.test.ts:110-125` uses a stub `Db`,** which departs from the plan's
"real Postgres, no mocks". The departure is justified and the test comment says why — provoking a
listing-query failure against a real pool is awkward — and it pins a property that matters. Noting
it only so the deviation is a recorded choice rather than an unnoticed drift.

---

## Deferred findings triage

1. **Task 3 — no test for the "`latest` present but missing from `versions`" guard.** *Accept.*
   The guard at `src/registry.ts:56-59` is three lines and demonstrably correct by inspection; the
   gap came from the plan's test listing. Worth adding alongside the zod validation in Important
   #2, since that work touches the same file.
2. **Task 4 — the stop function is verified by review, not by a test.** *Accept as a blocker, but
   add the test.* I re-traced it independently and agree there is no hole: `stopped` is checked at
   the top of `scheduleNext`, so a pass that completes after `stop()` schedules nothing, and
   `clearTimeout` on an already-fired handle is a harmless no-op. Pair this with Important #3 —
   both are cheap tests and it is efficient to write them together.
3. **Task 5 — the `REGISTRY_URL` row's asymmetric "Unset disables catalogue refresh" note.**
   *Accept.* The statement is true and the surrounding prose already says all three are required.
   Purely stylistic.
4. **Task 2 — `presentCatalogRow` mixes derivation with shaping and lives in `app.ts`.** *Accept.*
   It is one 20-line function with a single caller pair, and extracting it now would be
   speculative. The trigger for revisiting is concrete and correctly identified: the first
   non-HTTP caller that needs `paid`/`stale`.

---

## Recommendations

- Fix the three Important items before merge. Together they are roughly one small commit: a guard
  plus tests on two handlers, a zod schema in `registry.ts`, and two tests (unauthenticated
  catalogue route, refresher stop function). None require a design change.
- Resolve Minor #4 by editing the spec or the code, and pin whichever you choose with a test. The
  spec currently contradicts itself between §4 and its Testing table, so it needs an edit either
  way.
- **On the spec:** it is strong, and the "settled by measurement" table is the most valuable thing
  in it — the Basic-vs-bearer decision is documented as evidence rather than assertion, which is
  why the client needed no revision. Two corrections: the §4/Testing-table contradiction above,
  and the `isPaidPackage` caveat about Verdaccio's `public_packages` deserves to be more than a
  caveat, since a populated list would make the website advertise a free package as paid with no
  signal that it had happened. A follow-up ticket, not branch scope.
- **On the plan:** the pattern you asked about recurs. Important #1 is a spec requirement the plan
  dropped while specifying the handler verbatim, and the two previously-traced findings were weak
  test bodies from the same source. The common factor is that the plan supplies finished code and
  finished tests, so an implementer following it faithfully inherits its omissions and has little
  reason to re-read the spec. Consider having plans cite the spec clause each handler satisfies
  rather than restating it as code — the divergence then shows up at review time.
- For E1: the detail route publishes the full readme of paid packages to whatever gl3-web renders.
  That is clearly intended (it is marketing copy), but there is no per-package control over it, so
  a publisher's internal notes in a readme would go public on the next refresh. Worth a line in
  E1's spec.

---

## Assessment

**Ready to merge?** With fixes

**Reasoning:** The security boundary this branch could plausibly have damaged is provably
untouched, the credential never escapes configuration, and the failure paths degrade to stale data
exactly as designed — but the routes skip a validation step the spec explicitly requires, the
registry response is cast rather than validated at a boundary where publisher-authored data can
permanently stall a package's refresh, and nothing pins that the catalogue routes are
authenticated. All three are small and localized.
