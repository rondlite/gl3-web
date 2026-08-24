# Final branch review: feat/plugin-pages

**Range:** cf19e83..579c7b1 (10 commits)
**Spec:** docs/superpowers/specs/2026-08-24-plugin-pages-design.md (binding)
**Plan:** docs/superpowers/plans/2026-08-24-plugin-pages.md
**Ledger:** .superpowers/sdd/2026-08-24-plugin-pages/progress.md
**Verdict:** not ready to merge. Two must-fix defects, three unimplemented spec requirements.

Reviewed as a whole, not task by task. Suite state (70/70, typecheck clean) taken as given
and not re-run; everything asserted below was verified by executing the branch's own code
against the repository's own build output.

## Strengths

These are real and worth stating before the issues.

**The script-execution boundary is closed.** I traced every path from catalogue data to
rendered output:

| Path | Sanitised / escaped by |
| --- | --- |
| `Plugin.descriptionHtml` | `renderInline` (catalog.ts:78) |
| `PluginDetail.readmeHtml` | `renderBlock` (catalog.ts:151) |
| page title, OG title, `<h1>` | `escapeHtml(plugin.name)` (plugin-page.ts:77) |
| `<meta name="description">`, `og:description` | `escapeHtml` (plugin-page.ts:78) |
| canonical, `og:url` | `escapeHtml` (plugin-page.ts:79) |
| stylesheet `href` | `escapeHtml` (plugin-page.ts:84) |
| version, license, install | `escapeHtml` (plugin-page.ts:113-116) |
| sitemap `<loc>` | `escapeHtml` (plugin-page.ts:141) |
| card description | server-sanitised, `v-html` only (PluginGrid.vue:102) |

The single unescaped interpolation is `readmeHtml` at plugin-page.ts:117, which is
sanitiser output by construction. There is no second rendering path in the browser: no
markdown parser and no sanitiser reach the bundle, exactly as the spec intended. The
route's scope allowlist (app.ts:75) plus the membership check in `getDetail`
(catalog.ts:243) means an invented URL never reaches store-api and never grows the detail
cache. `503` rather than `404` on outage, on both the detail route and the sitemap, is the
right call for crawlers.

**Task 1's deviation from the plan was correct and load-bearing.** Adding `rel` and
`target` to `allowedAttributes` (markdown.ts:33) is required because sanitize-html filters
attributes after `transformTags` runs. The plan's config would have stripped the link
hardening it had just added, and the test would still have been green on everything else.

## Issues

### Critical

#### 1. `discoverStylesheets` never matches this repository's own build output

- **File:** server/plugin-page.ts:40; site/.vitepress/dist/index.html
- The regex requires the literal `rel="stylesheet"`. Vite emits
  `<link rel="preload stylesheet" href="/assets/style.DM80HEo_.css" as="style">`. The
  attribute value is `preload stylesheet`, so the pattern does not match.
- Verified by running the shipped function against the checked-in build:

  ```
  discoverStylesheets('./site/.vitepress/dist') -> []
  ```

- **Failure this causes:** every plugin page in production renders with `FALLBACK_STYLES`.
  The spec's entire "look like the site" mechanism (spec:127-135) is dead: no VitePress
  palette, no typography, and the `THEME_SCRIPT` that adds `.dark` to `documentElement` has
  nothing to act on, because the custom properties it depends on live in the stylesheet
  that was never linked. The built CSS does contain the rule that would have worked
  (`body{...color:var(--vp-c-text-1);background-color:var(--vp-c-bg)}` and
  `.dark{--vp-c-bg:#1b1b1f}`), so the design is sound and only the discovery is broken.
  A path the spec designed as graceful degradation is the only path anyone will ever see.
- **Why the process missed it:** `discoverStylesheets` is the one function on this branch
  with no test at all. `plugin-page.test.ts` supplies `stylesheets: ['/assets/style.abc123.css']`
  by hand, which tests `renderPluginPage` and proves nothing about discovery. The plan
  supplied this regex; each task review checked the code against the plan; nobody ran it
  against a real `index.html`. This is the exact failure mode the brief asked me to look
  for.
- **Fix:** match `stylesheet` as a token within `rel`, and do not depend on attribute
  order:

  ```ts
  /<link\b(?=[^>]*\brel="[^"]*\bstylesheet\b[^"]*")[^>]*\bhref="([^"]+)"/g
  ```

  Add a test whose fixture is the real shape (`rel="preload stylesheet"`, `href` after
  `rel` and before `as`). Better still, assert against `site/.vitepress/dist/index.html`
  when it exists, so a future Vite change that alters the emitted markup fails CI rather
  than silently unstyling every plugin page.

#### 2. `renderInline` passes block-level raw HTML through, defeating card uniformity and allowing badge spoofing

- **File:** server/markdown.ts:71-76 (`baseOptions.allowedTags` is sanitize-html's full
  default list, which includes `h1`-`h6`, `div`, `table`, `pre`, `section`)
- `marked.parseInline` does not convert `# Heading`, but it passes raw HTML through
  untouched, and the sanitiser then allows it. Verified against the shipped module:

  ```
  renderInline('<h1>BIG</h1><div>block</div><table><tr><td>cell</td></tr></table>')
    -> '<h1>BIG</h1><div>block</div><table><tr><td>cell</td></tr></table>'
  renderInline('x <span class="gl3-tag is-paid">FREE</span>')
    -> 'x <span class="gl3-tag is-paid">FREE</span>'
  ```

- **Failure this causes:** two, one cosmetic and one commercial.
  1. The spec's stated guarantee, "a description that begins with `#` cannot turn a card
     into a heading. Cards stay visually uniform no matter what a README opens with"
     (spec:82-84), does not hold. A publisher writes raw HTML instead of markdown and gets
     a heading, a table, or a `<pre>` block inside the card, breaking the grid the clamp
     exists to protect.
  2. `span: ['class']` is allowlisted and `custom.css` is global and unscoped, so a
     publisher-controlled description can render the site's own `.gl3-tag.is-paid`
     "Premium" badge, or any other site class, inside its card. On a storefront that is a
     spoof of the site's own trust signalling, not just a layout bug.
- Not XSS: `<script>`, `<style>` and event handlers are still removed, and I confirmed the
  four sanitiser tests genuinely exercise that.
- **Why the process missed it:** the plan's test asserts `renderInline('# Heading')`
  contains no `<h1>`. That passes because `parseInline` never emits one, so the test proves
  nothing about the allowlist it was written to protect. It passed for the wrong reason.
- **Fix:** give `renderInline` its own `allowedTags` rather than inheriting the block list.
  Inline formatting only: `a, b, i, em, strong, code, del, s, sup, sub, br, abbr, kbd`.
  Drop `class` from the inline `allowedAttributes` entirely; a card description has no
  legitimate use for site class names. Add tests for the raw-HTML forms
  (`<h1>`, `<div>`, `<table>`, `<span class>`), which is what the existing test intended to
  cover.

### Important

#### 3. Spec failure-table row 3 is not implemented: a catalogued package with an unfetchable README returns 503, not a page

- **Files:** server/catalog.ts:179-183, server/app.ts:90-94
- Spec table (spec:197): "package catalogued but README never fetched | page renders with
  metadata and a note in place of the README".
- What the code does: when the list cache is warm but the detail fetch throws and no detail
  is cached, `refreshDetail` returns `{available:false, plugin:null}`, and the route turns
  that into `503`. The note branch at plugin-page.ts:87 is reachable only when store-api
  successfully returns a package whose `readme` is `null`.
- **Failure this causes:** during a store-api outage with a warm list cache, `/plugins.html`
  renders a complete grid and every card links to a page that returns 503, even though the
  server holds the name, version, description, license and install line for each of them
  and could render precisely the page the spec describes. Spec row 2 scopes 503 to
  "store-api unreachable, nothing cached"; that is not this case.
- **Fix:** in `refreshDetail`'s catch, when nothing is cached but `list` is known, return
  `{available: true, plugin: {...list, readmeHtml: null}}`. Reserve `available:false` for
  the list itself being unavailable, which `getDetail` already handles at catalog.ts:237.

#### 4. The detail cache has no negative cache, which the spec named explicitly

- **File:** server/catalog.ts:143-185
- Spec:110-113: the detail cache "inherits the list cache's semantics exactly, because they
  are the properties that made the list reliable: in-flight coalescing [...], last known
  good on failure [...], and a short negative cache so an outage does not map every visitor
  onto an upstream attempt."
- Coalescing is present (`detailPending`). Last known good is present. The negative cache
  is absent: the list has `failedAt` and `NEGATIVE_CACHE_MS` (catalog.ts:114, 136, 219), the
  detail path has no equivalent.
- **Failure this causes:** with a warm list and a failing detail endpoint, every request for
  every cold plugin page opens its own upstream call and waits out the 5s timeout. A crawler
  walking the sitemap during an outage produces one upstream attempt per plugin per pass.
- **Fix:** record a per-package `failedAt` alongside `details` and short-circuit within
  `NEGATIVE_CACHE_MS`. Fixing #3 removes most of the visitor-facing harm but not the retry
  storm, since a request that answers from list metadata still attempts the fetch first.

#### 5. Nothing advertises `sitemap.xml`, so the prerendering's audience may never arrive

- **Files:** repository has no `robots.txt` and no `site/public/` directory; nothing emits
  `<link rel="sitemap">`.
- Spec:175-179 states the sitemap is "what makes them reachable" and that "without it these
  pages would be prerendered for an audience that never arrives".
- **Failure this causes:** the standard way to advertise a sitemap is the `Sitemap:`
  directive in `robots.txt`. Major engines do also probe `/sitemap.xml` directly, so this is
  a weakening rather than a total break, but the branch's stated purpose currently depends
  on a manual Search Console submission that nothing in the repository records or verifies.
- Related, and the reason I rate this important rather than minor: of the two audiences the
  spec names, non-JS human visitors gain nothing on this branch. The `<noscript>` block
  (PluginGrid.vue:123-129) is unchanged and still sends them to npm, not to the new pages,
  and the only link to a plugin page anywhere on the site is inside the client-rendered
  grid. Crawlers are served by the sitemap; non-JS visitors are served by nothing.
- **Fix:** add `site/public/robots.txt` containing `Sitemap: https://gl3.dev/sitemap.xml`
  (VitePress copies `public/` verbatim). Separately, consider listing the plugin page links
  inside the `<noscript>` block, though that needs data the build cannot reach, so a link to
  `/sitemap.xml` may be the honest limit.

#### 6. `pluginHref` and the route's scope allowlist encode the same URL scheme twice and can disagree

- **Files:** server/catalog.ts:31-34, server/app.ts:75
- `pluginHref` generates `/plugins/<scope>/<name>.html` for any scope. The route serves only
  `gl3` and `gl3-plugins`.
- **Failure this causes:** a third scope entering the catalogue produces cards whose titles
  link to URLs the server 404s, and, worse, a sitemap that advertises those URLs to
  crawlers. The two facts live 200 lines apart in different modules with nothing tying them
  together, and no test would catch the divergence.
- Separately, `pluginHref('unscoped-name')` returns `/plugins/unscoped-name/undefined.html`,
  because the destructured `name` is `undefined` under `noUncheckedIndexedAccess` and the
  template literal stringifies it. Today's catalogue is scoped-only, so this is latent.
- **Fix:** export the scope allowlist from `catalog.ts` and have both `pluginHref` and the
  route consume it, or have `pluginHref` return `null` for a name it cannot address and
  filter those out of both the grid payload and the sitemap.

### Minor

7. **Dead class hooks.** `.gl3-plugin-page`, `.gl3-plugin-page-header` and
   `.gl3-plugin-page-meta` (plugin-page.ts:104-111) have no rules in `custom.css` or
   anywhere else. Harmless, but they read as styling that exists and does not. Either style
   them or drop them. Note this becomes visible only once #1 is fixed.

8. **`toDetail` parses seven fields and uses one.** catalog.ts:149-152 validates
   `package`, `paid`, `version`, `description`, `keywords`, `license` and `readme`, then
   spreads the *list* copy over all of them and keeps only `readme`. Defensible as boundary
   validation, but `detailSchema` now duplicates `responseSchema`'s shape, and a reader will
   reasonably assume the detail fields are the ones rendered. Worth a comment saying the
   list copy wins on purpose, or narrowing the schema to `{ readme }`.

9. **The clamp is measured once.** PluginGrid.vue:68-69 calls `measure()` after mount only.
   A window resize or a late web-font load changes whether a description overflows, and the
   "Show more" control will not appear or disappear to match. A `ResizeObserver` on the
   grid, or a debounced resize listener, is a few lines.

10. **Detail cache entries are never evicted** for packages that leave the catalogue
    (catalog.ts:146). Bounded by catalogue size, so not a leak in practice, but a removed
    package's README stays resident for the process lifetime.

11. **No `Cache-Control` on the plugin pages or the sitemap.** Both are cheap to regenerate
    and back a 60s catalogue cache; a short `public, max-age` would cut repeat crawler load.

## Triage of the ledger's deferred minors

| Deferred item | Ruling | Reasoning |
| --- | --- | --- |
| Task 3: `escapeHtml` omits the apostrophe | **Can stand.** Fix opportunistically. | I checked every interpolation in `plugin-page.ts`: all sit inside double-quoted attributes (lines 84, 95-100) or in element text (110-116). No call site is exposed. The ledger's concern is right that the helper is a security primitive, and adding `.replace(/'/g, '&#39;')` is one line with no downside, so do it while touching the file for #1. Not a merge blocker. |
| Task 3: em dash in the implementer's report | **Can stand.** | Verified: `grep` for the character across `server/`, `site/.vitepress/theme/` and `README.md` returns nothing, and this branch's spec, plan and ledger are clean. Report hygiene only, and the report is not shipped. |
| Task 5: no `aria-controls` on the expand button | **Can stand.** | The button immediately follows the paragraph it toggles and carries `aria-expanded`, which is the part screen readers announce. Adding `aria-controls` needs a stable per-card id, which is worth doing on the next pass at this component but does not block. |
| Task 5: `-webkit-line-clamp` with no standards-track fallback | **Can stand.** | Support is universal in current browsers. More to the point, the degradation is correct by construction: where the clamp does not apply, `scrollHeight === clientHeight`, `measure()` adds nothing to `overflowing`, no control renders, and the full text simply shows. Nothing breaks. |

## Assessment

**Ready to merge?** No.

**Reasoning:** The security boundary this branch exists to establish is genuinely closed
against script execution, and the caching and status-code design is sound. But
`discoverStylesheets` does not work against this repository's own build output, so the
prerendered pages ship unstyled, and `renderInline` inherits a block-level allowlist that
lets a publisher put a heading, a table or a counterfeit "Premium" badge inside a card. Both
were supplied verbatim by the plan and both were checked by per-task reviews that compared
the code to the plan rather than to reality. Findings 3, 4 and 5 are requirements the spec
states in plain text that no task implemented. Fix 1 and 2 before merge; 3, 4 and 5 are the
spec's own bar and should not be deferred without an explicit ruling recorded in the ledger.
