# gl3-web: the GL3 website

**Date:** 2026-08-24
**Sub-project:** E1 of A to E
**Repo changed:** `rondlite/gl3-web`
**Depends on:** B (plugin catalogue in store-api), shipped and merged
**Status:** approved, not implemented

## Problem

GL3 has a game server, a documentation site, a private plugin registry, and a store API
that can now serve a plugin catalogue. It has no website. Nobody can find out what GL3
is, why they would move off Gangster Legends V2, what the premium licence includes, or
what plugins exist, without reading a GitHub README.

Sub-projects A and B built the machinery that lets a website list paid plugins safely: a
credential that reads package metadata and provably cannot download a paid tarball, and a
catalogue endpoint that caches that metadata. Nothing consumes it. E1 is the consumer,
and it is the first piece of this programme a person can look at.

## Goal and non-goals

**Goal:** a website at gl3.dev that pitches GL3 to operators, lists the plugin catalogue,
states what premium costs and covers, and hands developers off to docs.gl3.dev.

E1 is complete when the site builds, deploys as one container, renders the live catalogue,
and still renders correctly when store-api is unreachable.

**Non-goals**, deliberately deferred:

| Deferred to | What |
| --- | --- |
| D | Stripe checkout, buyer accounts, npm token delivery |
| E2 | login, the signed in area, self service token management |
| later | per plugin detail pages, search, a blog, adopting the palette in docs.gl3.dev |

No accounts. No checkout. No signed in area. The pricing page's call to action links out
until D exists.

## Audience

The site serves two populations and leads with one.

**Operators running a game** lead. They are who premium is sold to, and they have a
concrete problem the site can name: the GL2 and MCCodes lineage is aging in a specific,
verifiable way, with `int(11)` money columns overflowing past roughly 2.14 billion on long
running games and sha256 password hashes with no work factor. GL3's answer is bigint
money, argon2id, real foreign keys, and a one command migration that carries an existing
game across with its players and passwords.

**Developers building plugins** are the secondary path, routed quickly to docs.gl3.dev and
the public `@gl3/*` scope. They are not the pitch, but the site must not feel like it was
written without them in mind, because they are how the plugin ecosystem grows.

## Architecture

### One container, two halves

VitePress builds the static site. A small Hono server serves that build output and hosts
`/api/*`. The image publishes as `ghcr.io/rondlite/gl3-web`, matching how `gl3-server` and
`gl3-store-api` already ship.

Hono rather than Fastify: store-api is Hono 4 with zod, this is the only other service
that talks to it, and one runtime across both keeps them legible to the same reader.

```
browser ──> gl3-web (Hono)  ──> store-api /v1/catalog/packages
              ├── static VitePress output
              └── /api/plugins   (holds INTERNAL_API_KEY)
```

**The browser never sees `INTERNAL_API_KEY` and never talks to store-api.** That is the
whole reason a server exists here at all; a purely static site could not hold the
credential. gl3-web runs on the same private network as store-api, exactly as Verdaccio
does today, so store-api keeps the property B established: it exposes no public route.

### Repository layout

| Path | Responsibility |
| --- | --- |
| `site/` | VitePress source: the four pages, config, and theme customisation |
| `site/.vitepress/config.mts` | Nav, metadata, and the link out to docs.gl3.dev |
| `site/.vitepress/theme/` | Palette tokens and the small amount of custom styling |
| `server/app.ts` | Hono app factory: static serving plus `/api/*`. No I/O at construction |
| `server/catalog.ts` | store-api client and the response cache |
| `server/env.ts` | Configuration, validated with zod |
| `server/index.ts` | Entrypoint: builds the app, listens, shuts down cleanly |
| `server/test/` | Server tests |
| `Dockerfile` | Builds the site, then runs the server over its output |

The split is by responsibility rather than by layer. `catalog.ts` owns everything about
talking to store-api and nothing about HTTP responses; `app.ts` owns routing and knows
nothing about caching.

## The catalogue path

### Request flow

The plugins page fetches `/api/plugins` from the browser. The Hono handler asks
`catalog.ts` for the current list. That module calls store-api's
`GET /v1/catalog/packages` with `Authorization: Bearer $INTERNAL_API_KEY`, keeps the
result in memory for `CATALOG_CACHE_MS`, and serves the cached copy until it expires.

The response is trimmed before it reaches the browser. store-api returns `position`,
`fetchedAt` and `stale`, which are operational details the page does not need. gl3-web
sends `name`, `paid`, `version`, `description`, `keywords`, `license` and an
`install` string.

### Three properties B already provides, and what E1 does with each

**`stale`** tells us store-api's cached metadata is old or was never fetched. E1 drops
any package whose `version` is null from the rendered list. A card with a null version
and no description is worse than no card: it looks broken rather than pending. A package
that is catalogued but has never successfully fetched is not yet ready to advertise.

**`paid`** distinguishes what premium unlocks from the free `@gl3/*` scope. The page
renders these as visibly different, because a developer looking for the SDK and an
operator looking at what they are buying must not confuse the two.

**Scoped names contain a slash.** B's spec recorded, from a measured test, that Hono
decodes an encoded scoped name in a path parameter but that an unencoded slash never
matches the route at all. E1 has no per package route in scope, so this does not bite
today. It is recorded here because the first thing anyone adds after E1 is a detail page,
and that is exactly where it will bite.

### Failure behaviour

This is the part worth getting right, because a marketing site that fails to load when a
backend blips is worse than one with no backend.

| Condition | Behaviour |
| --- | --- |
| store-api responds | Serve it, refresh the cache |
| store-api unreachable or errors, cache warm | Serve the last good cache, log a warning |
| store-api unreachable, cache cold | `200` with an empty list and a flag saying the catalogue is unavailable |
| Any of the above | The page still renders in full |

A cold cache with an unreachable upstream returns `200`, not `503`. The plugins page is
one section of a working website, and a failed fetch must degrade that section, not the
page. The response carries an explicit `available: false` so the page can say something
honest and short in place of the grid, rather than showing an empty grid that reads as
"there are no plugins" or a spinner that never resolves.

`/api/plugins` never throws. Errors are caught, logged once with the upstream status, and
converted into one of the rows above.

### Cache

In memory, in the process, no external store. `CATALOG_CACHE_MS` defaults to 60000. This
is a second cache in front of B's own 15 minute refresh, which is deliberate: B's cache
exists so the registry is not hammered, and this one exists so store-api is not called
once per page view. Neither makes the other redundant.

There is no cache invalidation endpoint. A minute of staleness on a marketing page costs
nothing, and an endpoint that clears it would be one more thing to secure.

## Pages

Four pages. Copy direction is given here because the words are most of the work on a
marketing site, and leaving them to implementation time produces filler.

### Landing

Leads with the operator claim: run your own gangster game, boot the whole stack with one
command, and bring an existing V2 game across with its players and passwords intact.

The V2 material is the strongest argument available and should be specific rather than
vague about "modernisation". Name the actual failures: money columns that overflow on long
running games, and password hashes with no work factor. Then name GL3's answers: bigint
money, argon2id, real foreign keys, and `gl3-migrate`.

Secondary section routes developers to docs.gl3.dev, the plugin SDK, and the architecture.

Links to the live demo at game.gl3.dev, which is the fastest way for a sceptical operator
to see the thing running.

### Plugins

The catalogue as a card grid. Each card carries the package name, version, description,
and the install line. Free and paid are visually distinct.

This page is the proof that A and B were worth building, and it is the only page whose
content is not in the repository.

### Pricing

One SKU. Premium unlocks every plugin, for any number of games.

State the unlimited deployments part plainly and early. Per seat and per server licensing
is what people expect from this kind of product, so a licence that does not work that way
is a selling point that only works if the reader notices it.

The call to action links out until D lands. It must not look like a broken checkout.

### Get started

The Docker one liner, what it stands up, and where to go next. Deliberately a launchpad
into docs.gl3.dev rather than a second copy of the getting started tutorial, which would
drift out of step with the real one.

## Visual system

Technical and restrained. The site should read like infrastructure someone would trust
with a live game's database, not like a game.

- A tight palette: one accent, a neutral ramp, and nothing else.
- Typographic hierarchy carries the page. Decoration does not.
- Generous whitespace, wide measure limits on body text.
- Code blocks are first class content, styled deliberately, not an afterthought.
- Dark and light both supported, since VitePress ships with the toggle and developers
  expect it.

docs.gl3.dev is stock VitePress with no branding today, so this is where GL3's visual
identity gets defined. Palette and type scale live in one token file so the docs site can
adopt them later without a rewrite. Making that happen is out of scope for E1.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `STORE_API_URL` | yes | Base URL of store-api, no trailing slash |
| `INTERNAL_API_KEY` | yes | The shared secret, same value store-api validates |
| `PORT` | no | Default 8080 |
| `CATALOG_CACHE_MS` | no | Default 60000 |
| `LOG_LEVEL` | no | Default `info` |

`STORE_API_URL` and `INTERNAL_API_KEY` are required, unlike B's optional registry
settings. The difference is deliberate: B added a capability to a service that already ran
without it, whereas a gl3-web with no store-api configured has no plugins page and should
refuse to start rather than serve a permanently broken section.

`INTERNAL_API_KEY` is never logged, never returned by any route, and never rendered into
the static output.

## Testing

Server side, with real tests:

| Case | Expected |
| --- | --- |
| store-api returns a catalogue | `/api/plugins` returns the trimmed shape, `available: true` |
| a package has a null version | dropped from the list |
| `paid` true and false | preserved through the trim |
| store-api errors, cache warm | last good list served, `available: true` |
| store-api errors, cache cold | `200`, empty list, `available: false` |
| two calls inside the cache window | store-api called once |
| cache expiry | store-api called again |
| `INTERNAL_API_KEY` | never appears in any response body |

The store-api client takes its fetch function as a parameter, the same seam B used, so
tests drive it without a network. A real HTTP server on an ephemeral port covers the
client's own request shaping, including that the bearer header is actually sent.

Static page content is not unit tested. That is the right call: asserting on marketing
copy produces tests that fail every time someone improves a sentence. The build itself is
verified in CI, so a broken VitePress config cannot ship.

## Deployment

The Dockerfile builds the VitePress output, then produces an image running the Hono
server over it. CI publishes to `ghcr.io/rondlite/gl3-web` on push to the default branch,
matching the other two services.

gl3-web needs network reach to store-api and the same `INTERNAL_API_KEY`. store-api needs
no change whatsoever for E1: B already built and shipped every route this consumes.

## Programme context

E1 is the fifth of six pieces and the first with a user interface.

| | Sub-project | Status |
| --- | --- | --- |
| A | Metadata only registry access | merged |
| B | Catalogue in store-api | merged |
| D | Stripe checkout and buyer provisioning | not started |
| E1 | The website | this spec |
| E2 | Signed in storefront | blocked on D |

Decisions carried in from earlier specs that shape E1:

- The site is GL3's actual website, not only a storefront, which is why the catalogue
  spans both the paid `@gl3-plugins/*` scope and the public `@gl3/*` one.
- One purchase unlocks any number of games. The licence is per buyer, never per
  deployment, and the pricing page says so.
- Buyers sign in with the `gl3_` token they already use for `npm login`. That matters to
  E2, not E1, but the pricing page should not imply an account system that does not exist.
