# Plugin cards and plugin pages

**Status:** design, awaiting review
**Repository:** gl3-web
**Depends on:** E1 (the storefront), gl3-store-api's catalogue endpoints

## The problem

A plugin's card on `/plugins.html` shows its description as plain text. npm derives
that description from the first line of the package README when `package.json` omits
one, and READMEs are markdown, so the Fixer plugin's card currently renders literal
asterisks around its pitch instead of bold text.

Three separate faults sit behind that one screenshot:

1. Markdown is displayed rather than rendered.
2. A description of any length is rendered at full length, so one verbose package can
   make its card several times taller than its neighbours.
3. The README that the description came from is never shown anywhere, so the only view
   of a paid plugin is a single line.

The third is the one that matters commercially. A store whose products have no
description page is not really a store.

## What this builds

Two things, sharing one rendering pipeline:

- **Rendered card descriptions**, clamped to three lines with an expand control on the
  cards that overflow.
- **A page per plugin** at a real URL, showing the full README, prerendered as HTML.

## Where rendering happens, and why

Markdown is converted to HTML **on the server**, not in the browser.

This is not the obvious choice, so the reasoning is worth recording. The first design
put `marked` and `DOMPurify` in the Vue component. Moving both to the server followed
from a constraint discovered while designing the detail pages: the site is built by
GitHub Actions, store-api has no public hostname, and so **the build cannot reach the
catalogue**. Anything generated at build time from catalogue data is impossible here.

The Hono server, by contrast, already holds `INTERNAL_API_KEY` and already fetches the
catalogue. It can render pages at request time. That gives real URLs and prerendered
HTML without the build depending on an internal service, and a newly registered plugin
gets a page on the next cache expiry rather than on the next deploy.

Rendering on the server changes the sanitiser. DOMPurify needs a DOM, which on Node
means dragging jsdom into the image. `sanitize-html` does the same job natively. The
compensation is that **the browser bundle grows by nothing at all**: no markdown parser
and no sanitiser ship to visitors, and there is one rendering path rather than two.

### Trust boundary

Package READMEs are publisher-controlled content. Sanitisation is the only thing
standing between a plugin author and script execution on `gl3.dev`, so it is the part
of this design with the least room for improvisation:

- An allowlist, never a denylist. `sanitize-html` defaults to allowlisting; the
  configuration extends the default tag list and nothing else.
- No `<script>`, no `<style>`, no event handler attributes, no `javascript:` URLs.
  These follow from the allowlist rather than being special-cased.
- Anchors carry `rel="noopener noreferrer"` and `target="_blank"`, so a publisher's
  link cannot reach back through `window.opener`.
- `href` and `src` are restricted to `http`, `https` and `mailto`.

The sanitiser runs on **every** path that produces HTML from package data. There is no
"trusted" branch, because the catalogue has no notion of a trusted publisher.

## Components

### `server/markdown.ts`

One module, two exported functions, one shared sanitiser configuration.

```
renderInline(src: string | null): string | null
renderBlock(src: string | null): string | null
```

`renderInline` is for card descriptions. It uses `marked.parseInline`, so emphasis,
inline code and links render, but a description that begins with `#` cannot turn a card
into a heading. Cards stay visually uniform no matter what a README opens with.

`renderBlock` is for the README on a detail page: full block parsing, headings, lists,
fenced code, tables.

Both return `null` for `null` input, so a package with no description is still
distinguishable from one with an empty description.

**Images differ between the two on purpose.** `renderBlock` permits `<img>` over https,
because badges are a normal part of a README and stripping them leaves visible gaps.
`renderInline` strips images, because a card is a three-line summary and an image in it
breaks the grid alignment. This is the one place the two configurations diverge, and it
is a deliberate split rather than an oversight.

### `server/catalog.ts` (modified)

`Plugin` gains `descriptionHtml: string | null`, produced by `renderInline`. The plain
`description` stays: the detail page needs plain text for its `<meta name="description">`,
where markup would be wrong.

A second cache is added for per-package detail, holding the README. It is **lazy**: a
package's detail is fetched from `/v1/catalog/packages/:package` the first time someone
asks for that page, not eagerly for every package on every list refresh. Fetching all
of them on each refresh would multiply upstream calls by the catalogue size on a timer,
to populate pages nobody may visit.

The detail cache inherits the list cache's semantics exactly, because they are the
properties that made the list reliable: in-flight coalescing so concurrent requests for
a cold page make one upstream call, last known good on failure so an outage shows stale
content rather than an error, and a short negative cache so an outage does not map every
visitor onto an upstream attempt.

### `server/plugin-page.ts`

Renders one plugin into a complete HTML document.

**This page does not run VitePress.** VitePress hydrates its pages with Vue, and Vue
replaces server-rendered DOM that does not match what it expects, so injecting rendered
README HTML into a built VitePress page would be fighting hydration for control of the
same nodes. The detail page is therefore a standalone document.

To still look like the site, it:

- links the built stylesheet, whose filename is content-hashed per build and is
  discovered once at startup by reading `<link rel="stylesheet">` out of the built
  `index.html`. If that lookup fails the page still renders, with a small inline
  base stylesheet, so a missing or restructured build degrades the appearance rather
  than the page.
- uses VitePress's CSS custom properties for colour, so it tracks the theme.
- carries a short inline script that applies the stored theme preference from the
  `vitepress-theme-appearance` key, so a visitor in dark mode does not hit a white page.
- has its own minimal header (GL3, linking home; Plugins, linking back to the list) and
  the same footer text as the site.

**The trade-off, stated plainly:** detail pages will not have VitePress's nav bar,
search box or theme toggle. They match the palette and typography, not the chrome. The
alternative, making the whole plugins section a VitePress page rendered on the client,
gives up the prerendering that is the point of the exercise. If the visual difference
reads as disconnected once it is on screen, that is the moment to revisit this, and it
is a contained change.

Each page emits `<title>`, `<meta name="description">` from the plain-text description,
and Open Graph tags. Metadata was deferred in E1 until a URL was worth promoting. These
pages are that URL.

### `server/app.ts` (modified)

Three routes, all registered **before** the static handler, which must stay last:

| Route | Behaviour |
| --- | --- |
| `GET /plugins/:scope/:file` | the detail page, where `:file` is the package name plus `.html` |
| `GET /sitemap.xml` | the four built pages plus every plugin page |
| `GET /api/plugins` | unchanged, now carrying `descriptionHtml` |

Status codes on the detail route: `200` when the package is catalogued, `404` through
the existing handler (so an unknown plugin gets the styled VitePress 404 page) when it
is not, and `503` when the catalogue is unreachable and nothing is cached, because a
crawler must not record an outage as a permanent absence.

### URLs

`@gl3-plugins/fixer` becomes `/plugins/gl3-plugins/fixer.html`.

The scope keeps its own path segment with the `@` dropped. The tempting flatter form,
joining scope and name with a hyphen, is ambiguous: `@gl3-plugins/fixer` and
`@gl3/plugins-fixer` would both flatten to `gl3-plugins-fixer`, and both scopes are
real in this catalogue. Two segments cannot collide.

The `.html` suffix matches the rest of the site, which runs with `cleanUrls` off.

### Discovery

Crawlers cannot see the plugin grid, because it is client-rendered, so they would never
find the detail pages by following links. `sitemap.xml` is what makes them reachable.
Without it these pages would be prerendered for an audience that never arrives, which
would waste most of the value of building them this way.

### `PluginGrid.vue` (modified)

The description renders through `v-html` from `descriptionHtml`, which the server has
already sanitised. Card titles link to the detail page.

Descriptions clamp to three lines. After mount, each card compares `scrollHeight` to
`clientHeight` and shows a "Show more" control only where the text actually overflows,
so short descriptions do not get a control that expands nothing. The control toggles
`aria-expanded` and switches to "Show less".

## Failure behaviour

| Condition | Result |
| --- | --- |
| store-api unreachable, list cached | stale list served, as today |
| store-api unreachable, nothing cached | grid says so, detail pages return 503 |
| package catalogued but README never fetched | page renders with metadata and a note in place of the README |
| package not catalogued | 404, styled |
| built stylesheet not found at startup | detail pages render with inline base styles |
| description is `null` | card shows no description block, page shows metadata only |

## Testing

Everything that decides what HTML a visitor receives now lives on the server, so the
whole rendering pipeline is testable without a browser, a DOM shim or a component
harness. That is a direct benefit of moving rendering off the client, and it is why
`vitest.config.ts` does not need to change.

What remains untested is narrow and named here rather than left implied: the card's
clamp measurement compares `scrollHeight` to `clientHeight` in a mounted component, and
proving that would mean adding `@vue/test-utils` and a DOM implementation for one
behaviour. The existing CI canary, which greps the built `plugins.html`, already catches
the failure mode that actually bit E1, where the component silently stopped being
registered and every check stayed green. The clamp itself is CSS plus one comparison,
and a wrong answer there shows a control that expands nothing rather than breaking the
page.

The markdown module is pure and server-side, so it is tested directly with no DOM
shim. The security tests are the ones that must fail loudly if the sanitiser is ever
swapped, reconfigured or removed:

- `<script>alert(1)</script>` produces no script tag
- `<img src=x onerror=alert(1)>` produces no `onerror` attribute
- `[x](javascript:alert(1))` produces no `javascript:` URL
- an anchor gains `rel="noopener noreferrer"` and `target="_blank"`
- `renderInline` on `# Heading` produces no `<h1>`
- `renderInline` strips `<img>`; `renderBlock` keeps an https one
- `**bold**` produces `<strong>` in both

Route tests cover a 200 with the README present in the body, a 404 for an uncatalogued
name, a 503 when the catalogue is cold and failing, the scope round trip for both
scopes, and that `sitemap.xml` lists every catalogued package.

Cache tests cover coalescing, last known good, and that a detail fetch failure does not
evict a cached README.

One test asserts the ordering that E1 already got wrong once: the detail route must
resolve ahead of the static handler.

## Dependencies

`marked` and `sanitize-html` (with its types) as runtime dependencies of the server.
Nothing is added to the browser bundle.

## Not in scope

Search, filtering, pagination, version history, screenshots, ratings, and any
authenticated view. E2 covers the signed-in storefront and is where "you own this"
belongs.

Adding a `description` to `@gl3-plugins/fixer`'s own `package.json` is an upstream
change in a different repository. It would improve that one card, and it is unrelated
to whether this site renders markdown correctly.
