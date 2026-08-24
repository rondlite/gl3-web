# Final branch review: gl3-web (E1)

**Branch:** `feat/gl3-web-site`, `334e44a..dfdbe50`
**Reviewer:** senior code review, whole branch, single pass plus targeted verification
**Spec:** `docs/superpowers/specs/2026-08-24-gl3-web-site-design.md`
**Plan:** `docs/superpowers/plans/2026-08-24-gl3-web-site.md`

Read-only review. I did not build the site, build the image, or touch the working tree.
Where I inspected files outside the diff I name the risk and what I checked.

---

## Strengths

The central architectural claim of this sub-project is sound and it is implemented the way
the spec argues for it.

**The secret is genuinely contained.** I traced every path `INTERNAL_API_KEY` could take.
It is read in `server/index.ts:564` and handed only to `createStoreApiFetch`, which puts it
in an outbound `authorization` header and nowhere else. `server/log.ts` never receives it:
the request middleware logs method, path, status and duration only, never headers or
bodies. The two places that log an error (`server/app.ts:343` and `server/app.ts:361`) log
`err.message`, and every error message this codebase can produce is a constructed string
(`store-api responded 401`) or a platform message (`fetch failed`, `The operation was
aborted due to timeout`), none of which carry the URL or the key. The `/api/plugins` catch
returns a fixed literal rather than the caught error. Nothing under `site/` references the
variable, so it cannot reach the static output. The Dockerfile takes no build arg and CI
passes no secret to the build. The dedicated leak test at `server/test/app.test.ts:686`
tests the right property for the right stated reason.

**The failure design is the best part of the branch.** `server/catalog.ts` parses the
upstream response with zod rather than casting, so a response gl3-web cannot understand
degrades to "unavailable" instead of throwing somewhere further in, and that is covered by
a test. The three-way outcome (fresh, last known good, cold and unavailable) matches the
spec's table row for row. Returning copies with `[...cached]` rather than the array itself
is a real defect avoided, not a stylistic flourish, and the aliasing test proves it.

**Separation of concerns holds.** `catalog.ts` knows nothing about HTTP responses and
`app.ts` knows nothing about caching, exactly as the spec's layout table asks. Both take
their dependencies as parameters, which is why the tests need no network and no mocking
framework.

**The comments earn their place.** Nearly every comment in this branch states a constraint
or a reason that the code cannot show: why `serveStatic` is registered last, why a null
version is dropped, why the cold-cache path returns 200, why the response is parsed rather
than cast. That is the correct comment discipline and it is unusually consistent.

**Static serving is safe.** I checked the installed `@hono/node-server` serve-static
implementation and `hono/utils/filepath` directly, because a public server mounting a
directory at `/*` is a concrete traversal risk. `getFilePathWithoutDefaultDocument` rejects
any filename containing a `..` segment, and `decodeURIComponent` runs before that check, so
`%2e%2e%2f` is normalised into the rejected form rather than sneaking past it. I could not
construct an escape.

**No injection surface on the proxy.** `/api/plugins` takes no path parameter, no query
string and no body, and forwards nothing from the client to the upstream. There is no SSRF
vector and no way to steer the upstream request. This is worth stating explicitly because
it is the first thing to check on a route that fronts an authenticated service.

**The two silent failure modes found during the run were fixed properly.** The colliding
fixtures at `server/test/fixtures/site/api/plugins` and `.../healthz` make the ordering test
capable of failing, and the comment at `server/test/static.test.ts:1076` explains why the
fixture must exist. That is the right fix rather than a reworded assertion.

---

## Issues

### Critical (Must Fix)

None. I looked hard for one, particularly on the secret-containment path, and did not find
it. The design's central promise was verified in a real container by the controller, and my
static reading agrees with that result.

### Important (Should Fix)

#### 1. `/api/plugins` has no in-flight coalescing and no negative caching, so a public unauthenticated endpoint maps one-to-one onto authenticated upstream calls

**`server/catalog.ts:461-485`**

`get()` returns the cache only when `cached !== null && now() - cachedAt < cacheMs`. On a
cold or expired cache it calls `deps.fetchCatalog()` immediately, and `cached` is not
assigned until that promise resolves. Nothing memoises the in-flight promise. So N
concurrent requests arriving in the gap all issue their own upstream call.

The worse half is that failure never populates the cache. When store-api is unreachable,
`cached` stays `null` forever, so **every single request to `/api/plugins` for the whole
duration of the outage** opens a fresh connection to store-api, waits up to the 5000 ms
timeout, and writes an error log line. There is no backoff and no negative cache window.

Why it matters, in the terms the review brief asked about. This is the amplification
question. `/api/plugins` is public and unauthenticated by design; `GET /v1/catalog/packages`
is authenticated and lives on a private network. The route converts unauthenticated public
volume into authenticated upstream volume at a 1:1 ratio whenever the cache is cold, which
is precisely the moment store-api is least able to absorb it. A recovering store-api gets
hit with the full retry pressure of every page view. Three secondary effects: unbounded
outbound socket usage, unbounded error-log volume driven by anonymous traffic, and a spec
deviation, since the spec says errors are "logged once with the upstream status" while the
implementation logs once per request.

I stopped short of Critical because undici's per-origin connection pool caps the concurrency
somewhat, and because the blast radius is a sibling service's load rather than data exposure
or a gl3-web outage. It is still the strongest finding in the branch.

**Fix.** Two small changes in `createCatalog`, both testable with the existing seams:

- Hold the in-flight promise in a variable and return it to concurrent callers, clearing it
  in a `finally`. One shared upstream call per refresh, regardless of arrival rate.
- On the cold-cache failure path, record the failure time and return the cached
  `{available: false, plugins: []}` without calling upstream again until `cacheMs` has
  elapsed. Log the failure once per window rather than once per request.

#### 2. The pricing page never states a price, which the spec makes a goal

**`site/pricing.md`**, whole file

Spec line 23: the site "states what premium costs and covers". The page covers what premium
unlocks in detail and never names a number, a currency, a billing period, or even an
explicit "contact us for pricing" framing. The call to action is `[Get in touch]` pointing
at GitHub Discussions.

Why it matters: a page titled Pricing that contains no price is the single thing a
prospective operator opens the site to find. It reads as an oversight rather than a
deliberate choice, and the spec asked for it directly.

A second, smaller problem sits in the same file. Lines 1497-1506 describe the post-purchase
experience in the present tense ("Premium gives you an npm token for the private registry",
"Full instructions ship with the licence") while sub-project D, which builds checkout and
npm token delivery, is not started. The spec permits the CTA to link out until D lands but
says it "must not look like a broken checkout" and "should not imply an account system that
does not exist". Present-tense delivery copy attached to a Discussions link invites a reader
to try to buy something that cannot be bought yet.

**This traces to the plan, not the implementer.** The plan supplies this page verbatim at
`docs/superpowers/plans/2026-08-24-gl3-web-site.md:1162-1196`, including the missing price
and the present-tense delivery paragraph. The implementer transcribed it faithfully. See the
note on plan-supplied omissions below.

**Fix.** Add the price, or if it is genuinely undecided, say so in a way a reader can act
on: name what is being decided and how to be told when it lands. Move the token and install
instructions into future tense, or behind a line stating that purchasing opens soon.

#### 3. The plugins page renders a permanent "Loading the catalogue." to anything that does not run JavaScript

**`site/.vitepress/theme/components/PluginGrid.vue:1140-1176`**

`state` initialises to `'loading'` and is only ever changed inside `onMounted`, which does
not run during static generation. I read the built output at
`site/.vitepress/dist/plugins.html` to confirm what actually ships: the entire body of the
plugins section is `<p class="gl3-plugins-note">Loading the catalogue.</p>`, with no
`<noscript>` fallback anywhere on the page.

Why it matters. Two audiences see exactly this and nothing else: visitors with JavaScript
disabled or blocked, and any crawler or link previewer that does not execute JavaScript.
The spec calls this page "the proof that A and B were worth building". Having it indexed as
the words "Loading the catalogue." is the opposite of that. It is also, literally, the
failure the spec names at line 142 and tells the implementation to avoid: "a spinner that
never resolves".

There is an irony worth stating because it affects how much protection the CI canary really
provides. The CI step at `.github/workflows/ci.yml:107-108` greps the built HTML for
`gl3-plugins-note`. The only reason that string is present in the build is that the loading
state is what gets server-rendered. The canary and this bug share a string, so the check
confirms the component mounted and confirms nothing about whether the page is useful without
JavaScript.

**This also traces to the plan**, which supplies the component template verbatim at plan
line 1323 with the same initial state and no `<noscript>`.

**Fix.** Add a `<noscript>` block to `site/plugins.md` or the component carrying a short
honest sentence and a link to the catalogue's public face (docs.gl3.dev, or the `@gl3` npm
scope), so the page says something true rather than something pending. Changing the CI grep
to a distinctive phrase from that fallback rather than a CSS class name would also make the
canary independent of the loading state. See Minor 8.

#### 4. `SITE_DIST` accepts an absolute path and then silently serves nothing

**`server/env.ts:536`** and **`server/app.ts:370`**

This is the third instance of the failure shape the brief asked me to hunt for: green build,
green typecheck, all 26 tests green, broken in production.

`SITE_DIST` is validated as `z.string().min(1)` and passed straight to
`serveStatic({ root: siteDist })`. I read the installed implementation because this is a
concrete deployment risk. `getFilePathWithoutDefaultDocument` in
`node_modules/hono/dist/utils/filepath.js` builds `root + "/" + filename` and then runs
`path.replace(/^\.?\//, '')`, which strips a leading slash. An absolute root such as
`/app/site/.vitepress/dist` therefore becomes the relative path
`app/site/.vitepress/dist/...`, resolved against the process working directory, which will
not exist. `serveStatic` finds no file, calls `next()`, and Hono returns 404.

The result is a container where `/healthz` returns 200, `/api/plugins` returns the
catalogue, and **every page of the website returns 404**. A liveness probe pointed at
`/healthz`, which is the obvious thing to point it at, reports the service healthy
throughout. Nothing in the test suite catches it because `server/test/static.test.ts:1056`
uses a relative fixture path, and nothing in the README warns about it: the configuration
table at README line 244 documents `SITE_DIST` as an ordinary knob with a default and no
constraint.

**Fix.** Either reject absolute paths in the zod schema with a clear message, or normalise
an absolute value to a path relative to `process.cwd()` before handing it to `serveStatic`.
At minimum, document the constraint in the README table. A test asserting that an absolute
`siteDist` either works or fails loudly would make this observable.

#### 5. Unknown URLs return a bare plain-text `404 Not Found`; the built 404 page is never served

**`server/app.ts:370`**

`serveStatic` calls `next()` when no file matches, and no handler is registered after it, so
Hono's default not-found handler responds with the plain text body `404 Not Found` (confirmed
at `node_modules/hono/dist/hono-base.js:8`). Meanwhile VitePress emits a styled
`site/.vitepress/dist/404.html` (2032 bytes) that nothing ever reads.

Why it matters: this is a public marketing site. Every mistyped URL, every stale inbound
link from a forum post about GL2, and every link that rots after a page rename lands on
unstyled black-on-white terminal text with no navigation back into the site. The brief asked
whether the pages would embarrass the project in front of a prospective customer. This is
the one place where the answer is yes.

The existing test at `server/test/static.test.ts:1096` asserts only `res.status === 404`, so
it passes today and would keep passing after the fix, which means it does not constrain the
behaviour either way.

**Fix.** Add `app.notFound(...)` after the static mount that reads `404.html` from `siteDist`
and returns it with status 404, falling back to the current text response if the file is
absent. Extend the existing test to assert on the body.

#### 6. `STORE_API_URL` is validated as a non-empty string, not a URL, which defeats the stated reason for requiring it

**`server/env.ts:522-525`**

The spec's justification for making this variable required (spec lines 227-230) is that
"a gl3-web with no store-api configured has no plugins page and should refuse to start
rather than serve a permanently broken section". `z.string().min(1)` only catches the empty
and absent cases. The most likely real-world misconfiguration, a value with no scheme such
as `store-api:8080`, passes validation, the process boots reporting itself healthy, and then
every `fetch` throws for the lifetime of the container with a permanently cold cache. That
is exactly the permanently broken section the spec wanted boot-time failure to prevent, and
it compounds Important 1 by making the no-negative-cache path permanent rather than
transient.

**This traces to the plan**, which supplies `STORE_API_URL: z.string().min(1)` verbatim at
plan lines 212-215.

**Fix.** Use `z.string().url()` before the trailing-slash transform. The existing env tests
already cover the transform and would need no change; add one case asserting a schemeless
value is rejected.

#### 7. The Dockerfile is never built on a pull request

**`.github/workflows/ci.yml`** and **`.github/workflows/ghcr-publish.yml:117-121`**

CI runs typecheck, tests, the site build and the grid canary. It never builds the image. The
publish workflow builds the image but triggers only on push to `main` and on tags. So the
first time any Dockerfile change is exercised is after it has already merged, at which point
the failure mode is a red publish job on the default branch rather than a red check on a PR.

Why it matters: the container is the deliverable. This branch introduces the Dockerfile, the
multi-stage build, and the `dist/server/index.js` entrypoint, and the review evidence
confirms the image was built and run by hand. Nothing keeps that true. A future change to
`outDir`, to the `build` script, or to which paths are copied out of the build stage will
pass every CI signal and break the publish.

**Fix.** Add a `docker/build-push-action@v6` step to `ci.yml` with `push: false`, or a plain
`docker build .`. Building without pushing is cheap and turns the image into a checked
artifact. Running the built image and curling `/healthz` would be better still and is only a
few more lines.

### Minor (Nice to Have)

1. **The container runs as root.** `Dockerfile:181-192` sets no `USER`. The `node:22-alpine`
   image ships a `node` user for exactly this. Adding `USER node` before `CMD` costs one
   line. Also inherited verbatim from the plan at plan lines 1626-1637.

2. **No `HEALTHCHECK` despite `/healthz` existing.** The route is implemented and tested,
   and the Dockerfile does not use it. One `HEALTHCHECK` line makes the endpoint do the job
   it was written for. Note the interaction with Important 4: `/healthz` alone is not a
   sufficient readiness signal for this service, since it stays green when every page 404s.

3. **Compiled test files ship in the runtime image.** `tsconfig.json:1527` includes
   `server/**/*.ts`, which sweeps in `server/test/*.ts`, so `tsc` emits `dist/server/test/`
   and `COPY --from=build /app/dist ./dist` carries it into the runtime stage. Those files
   import `vitest`, which `npm ci --omit=dev` does not install. Nothing imports them so
   nothing breaks, but shipping test code into a production image is worth avoiding. Add a
   `tsconfig.build.json` with `exclude: ["server/test"]`, or exclude the directory and let
   vitest typecheck it separately.

4. **No Open Graph or Twitter card metadata, no canonical link, no favicon, no sitemap.** I
   read the emitted `<head>` in `site/.vitepress/dist/index.html` to check: it carries
   `title`, `description`, `generator` and asset preloads, and nothing else.
   `site/.vitepress/config.mts` sets no `head` array and no `sitemap` option. The spec's
   problem statement is that "nobody can find out what GL3 is", and the realistic discovery
   channels for GL2 operators are forum posts, Discord and Reddit, all of which render a
   shared link as a bare grey URL without `og:title` and `og:description`. A handful of
   `head` entries and VitePress's built-in `sitemap: { hostname: 'https://gl3.dev' }` would
   close this.

5. **No cache headers and no compression on static assets.** `serveStatic` in this version
   sets `Content-Type` and `Content-Length` only: no `Cache-Control`, no `ETag`, no
   `Last-Modified`, and `precompressed` is not enabled. The build is 1.1 MB, of which about
   284 KB is JS and CSS and most of the rest is Inter woff2 files, all served uncompressed
   on every cold visit. The asset filenames are content-hashed, so
   `Cache-Control: public, max-age=31536000, immutable` on `/assets/*` is safe and free.
   Compression needs either a middleware or a proxy in front; worth a deliberate decision
   rather than a default.

6. **No security response headers.** Nothing sets `X-Content-Type-Options: nosniff`,
   `Referrer-Policy`, or frame options. Hono ships `secureHeaders` middleware; one `app.use`
   would cover it. Low urgency for a site with no authentication and no user input, but this
   is the cheapest hardening available.

7. **The upstream timeout is hardcoded at 5000 ms.** `server/index.ts:571`. Every other
   tunable in this service is an environment variable with a documented default. This one is
   a literal in the composition root, which is inconsistent and means a slow store-api cannot
   be accommodated without a rebuild.

8. **The CI canary greps a CSS class name.** `.github/workflows/ci.yml:108` greps for
   `gl3-plugins-note`, which is also a selector in `site/.vitepress/theme/custom.css`. I
   verified the string appears exactly once in the current `plugins.html` and that VitePress
   is not inlining the stylesheet, so the check is meaningful today. It stops being
   meaningful the moment CSS inlining is enabled or a critical-CSS plugin is added. Grep for
   a distinctive sentence instead.

9. **Shutdown has no forced-exit timer.** `server/index.ts:584-586` calls `server.close()`
   and exits in the callback. A held-open connection delays that until Docker's SIGKILL at
   the ten second mark. A `setTimeout(() => process.exit(1), 5000).unref()` alongside it
   makes shutdown bounded.

10. **Outbound documentation links are unverified.** `site/get-started.md` and
    `site/index.md` link to `docs.gl3.dev/tutorials/getting-started`,
    `docs.gl3.dev/guides/create-a-plugin` and `docs.gl3.dev/gl3-vs-v2.html`. VitePress does
    not check external links, so a 404 on any of them ships silently and lands a prospect on
    an error page at the exact moment they decided to try the product. Worth a manual check
    before deploy, and worth a periodic link-check job later.

11. **One marketing claim I cannot verify from this repository.** `site/index.md:1442` states
    the engine is built on "Node 22, TypeScript in strict mode, Fastify, PostgreSQL 16, and
    Redis 7". The spec discusses Hono versus Fastify only in the context of gl3-web itself
    and never states what gl3-server uses. Everything else on the four pages that I could
    check against the spec is accurate, including the V2 claims about `int(11)` money
    columns, sha256 without a work factor, missing foreign keys, and `gl3-migrate`, all of
    which the spec supplies at lines 44-49. The owner should confirm the Fastify line, since
    a wrong stack claim on a landing page is the kind of thing a technical buyer notices.

---

## A note on plan-supplied omissions

The brief asked me to check for a fourth finding tracing to the plan rather than the
implementer. There is one, and it is the most substantive of the four so far.

The plan supplies finished page copy for `site/pricing.md` at plan lines 1162-1196. That
copy contains no price, and the spec's goal statement at spec line 23 requires the site to
state what premium costs. The implementer transcribed the plan's block faithfully and
correctly. Neither the plan's own step description nor any task-level review caught that a
page titled Pricing had no price in it, because at every checkpoint after the plan was
written the question being asked was "does the implementation match the plan" rather than
"does the plan match the spec".

Three further items in this report have the same origin, which I think strengthens rather
than dilutes the point:

- Important 3: the plan supplies `PluginGrid.vue` verbatim at plan line 1323 with the same
  `state = 'loading'` initial value and no `<noscript>` fallback.
- Important 6: the plan supplies `STORE_API_URL: z.string().min(1)` verbatim at plan lines
  212-215, weaker than the spec's own stated rationale for the field.
- Minor 1 and 2: the plan supplies the Dockerfile verbatim at plan lines 1615-1637 with no
  `USER` and no `HEALTHCHECK`.

The structural observation, offered because you asked for the plan to be challenged: a plan
that supplies finished code caps the implementation's quality at the plan's quality, and it
also removes the moment where an implementer would otherwise have had to think about the
thing the plan skipped. The catalogue module is the clearest illustration in the other
direction, since that is where the plan reasoned about behaviour rather than only supplying
text, and it is the strongest code in the branch. Consider having plans specify behaviour,
interfaces and the tests that pin them, and supplying literal code only where the exact text
is genuinely load-bearing.

One more spec-level note. Spec lines 236-256 give a testing table of eight cases, and all
eight are implemented. The table has no row for concurrency and no row for repeated failure,
which is why Important 1 slipped through with a full green suite. A spec that specifies
failure behaviour as carefully as this one does is worth extending with the question "what
happens when this fails a thousand times in a row".

---

## Deferred findings triage

1. **`err.message` without a stack trace on the `/api/plugins` catch.** Accept. It matches
   the convention in `catalog.ts`, and every error this code path can produce is a
   constructed message where a stack adds nothing.
2. **No `role="status"` or `aria-live` on the three text states.** Fix before merge. It is
   two attributes, and on this page the text state is the entire content until the fetch
   resolves, so a screen reader user currently gets no notification that anything changed.
3. **Cards are `<article>` in a `<div>` rather than list markup.** Accept as a standalone
   item, but do it while the file is open for item 2. A `<ul>` with `<li>` wrappers costs
   nothing and gives a screen reader the item count.
4. **Colliding-fixture tests fail by `res.json()` throwing rather than an explicit
   assertion.** Fix before merge. Two of the three silent failures found in this programme
   were tests that could not observe their own regression, and a test that passes by way of
   an exception is one refactor away from rejoining that category. Assert on the body.
5. **GitHub Action versions floating on major tags.** Accept. Consistency with the two
   sibling services is worth more than local hardening here, and pinning is a programme-wide
   decision rather than a gl3-web one.

---

## Recommendations

**Before merge**, in the order I would do them:

1. In-flight coalescing plus a negative-cache window in `createCatalog` (Important 1). This
   is the only finding with a security dimension and it is roughly fifteen lines.
2. Decide the pricing copy (Important 2). It is a content decision and needs the owner, not
   an engineer, so start it first even though it lands last.
3. `app.notFound` serving `404.html` (Important 5) and `z.string().url()` on `STORE_API_URL`
   (Important 6). Both are a few lines each with obvious tests.
4. A `<noscript>` fallback on the plugins page (Important 3), plus deferred items 2 and 4
   while those files are open.
5. `docker build` with `push: false` in `ci.yml` (Important 7), and `USER node` in the
   Dockerfile (Minor 1).

**Reasonable to defer** to a follow-up, provided they are actually written down: the
`SITE_DIST` absolute-path guard (Important 4) can ship as a README warning now and a schema
guard later, since the default is correct and nothing in the deployment path overrides it
today. The Open Graph metadata and asset cache headers (Minor 4 and 5) should be a single
small follow-up before any real promotion of the URL, because they are worth most at the
moment the link starts getting shared.

**For the programme**, two process suggestions. Have plans specify behaviour and tests
rather than supplying finished code, for the reason set out above. And add a "does the plan
still match the spec" checkpoint after plan approval, since four findings have now traced to
plans and every one of them was invisible to reviews that compared the implementation to the
plan.

---

## Assessment

**Ready to merge?** With fixes

**Reasoning:** The architecture is right, the secret is genuinely contained, and the
degradation behaviour that justifies this sub-project holds under real failure, so nothing
here is Critical. What blocks a clean merge is a public unauthenticated endpoint that
converts visitor volume into authenticated upstream calls at 1:1 with no coalescing and no
negative cache, and a pricing page with no price on it, both small to fix and both worth
fixing before this becomes the first thing anyone sees of GL3.
