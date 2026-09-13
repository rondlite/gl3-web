# gl3-web

The GL3 website: [gl3.dev](https://gl3.dev).

Pages built with VitePress, served by a small Hono server that also hosts the plugin
catalogue and Premium storefront APIs. The server holds `INTERNAL_API_KEY`, so the
browser never sees it and never talks to store-api directly.

```
browser ──> gl3-web ──> gl3-store-api /v1/catalog/packages
```

The server also renders a page per catalogued plugin and a sitemap:

- `GET /plugins/<scope>/<name>.html` renders the package's full README, for example
  `@gl3-plugins/fixer` at `/plugins/gl3-plugins/fixer.html`. The scope keeps its own path
  segment because flattening it into the name would collide: `@gl3-plugins/fixer` and
  `@gl3/plugins-fixer` would both flatten to the same string.
- `GET /sitemap.xml` lists the built pages and every plugin page. This is not decorative:
  the plugin grid is rendered in the browser, so a crawler following links would never
  reach a plugin page, and the sitemap is the only way they are discoverable. It returns
  `503` rather than a sitemap missing every plugin when the catalogue is unreachable.

Both routes are rendered server side rather than in the browser, and that is deliberate.
The site is built by GitHub Actions, and store-api has no public hostname, so the build
cannot reach the catalogue, and nothing can be generated from catalogue data at build
time. The server can: it already holds `INTERNAL_API_KEY` and already fetches the
catalogue for `/api/plugins`. A useful consequence is that no markdown parser or
sanitiser ships to visitors, and a newly registered plugin gets a page on the next cache
expiry rather than on the next deploy. Before undoing this and moving rendering back to
the browser, re-check that store-api is still unreachable from CI.

Package README markdown is converted to HTML in `server/markdown.ts`, using `marked` to
parse and `sanitize-html` to sanitise. Package READMEs are publisher controlled, so this
file is a security boundary; its tests in `server/test/markdown.test.ts` exist to fail if
the sanitiser is ever removed or reconfigured.

## Development

```bash
npm install
npm run dev:site      # VitePress on 5173, no catalogue
```

`npm run dev:site` gives fast page editing but no `/api/plugins`, so the plugins page
shows its unavailable message. To see the catalogue, build the site and run the server:

```bash
npm run build:site
STORE_API_URL=http://localhost:8081 INTERNAL_API_KEY=<key> npm run dev:server
```

## Tests

```bash
npm test
npm run typecheck
```

The server is tested. Page copy is not, deliberately: asserting on marketing sentences
produces tests that fail whenever someone improves one. The site build runs in CI so a
broken config cannot ship.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `STORE_API_URL` | yes | Base URL of gl3-store-api, no trailing slash |
| `INTERNAL_API_KEY` | yes | The shared secret store-api validates |
| `PORT` | no | Default 8080 |
| `CATALOG_CACHE_MS` | no | Default 60000 |
| `SITE_DIST` | no | Default `./site/.vitepress/dist`. Resolved relative to the process working directory, so an absolute path serves nothing. |
| `LOG_LEVEL` | no | Default `info` |
| `PUBLIC_ORIGIN` | no | Default `https://gl3.dev`. Absolute base URL used for canonical links, Open Graph tags and the sitemap. |

`STORE_API_URL` and `INTERNAL_API_KEY` are required. A site with no catalogue source has
a permanently broken plugins page, so it refuses to start rather than serving one.

## Failure behaviour

The catalogue is cached in memory for `CATALOG_CACHE_MS`. If store-api becomes
unreachable, the last good copy keeps being served. If it is unreachable and nothing has
been cached yet, `/api/plugins` returns `200` with an empty list and `available: false`,
and the page says the catalogue is temporarily unreachable.

The site never fails to load because store-api is down.

## Deployment

`npm run build && npm start`, or the image published to `ghcr.io/rondlite/gl3-site` on
every push to the default branch. gl3-web needs network reach to store-api and the same
`INTERNAL_API_KEY`.

The image is `gl3-site` rather than `gl3-web`, even though this repository is `gl3-web`.
`ghcr.io/rondlite/gl3-web` already exists and belongs to the GL3 monorepo, which publishes
the game's own web client under that name. A package belongs to one repository, so pushing
there from here fails with `permission_denied: write_package` no matter what permissions
the workflow is given.

## Premium storefront

The pricing decision is recorded in
[`docs/decisions/2026-09-13-premium-pricing.md`](docs/decisions/2026-09-13-premium-pricing.md):
€69 for the first year, €49 for annual renewals including after a lapse, VAT included.
Support is through [Discord](https://discord.gg/6U8ezKE8T); AI endpoints are optional.

`/pricing.html` handles new-buyer email capture and authenticated €49 renewals.
`/checkout.html` checks fulfilment and shows newly minted credentials once.
`/account.html` supports token sign-in, paid-through dates, the Stripe cancellation and
payment portal, and replacing the presented npm token.

The Hono server proxies only the explicit storefront routes to store-api. It keeps
credentials in AES-GCM encrypted, HttpOnly, SameSite cookies (Secure and `__Host-` prefixed
on HTTPS). Cookie encryption is derived from `INTERNAL_API_KEY` and `PUBLIC_ORIGIN`, so
all replicas must share both; rotating either signs users out. Account cookies expire
after eight hours, checkout proof after seven days. No credentials enter localStorage.
The API reauthenticates account credentials on every account operation.

`PUBLIC_ORIGIN` must be the exact browser origin, including the development port.
Browser POST routes require that Origin and JSON bodies. The Stripe webhook at
`POST /api/premium/webhook` instead forwards raw bytes and the Stripe signature for
store-api verification. Proxy error responses never expose upstream error text.

Deploy with the annual store-api implementation and its required migrations, prices,
portal configuration, Resend sender and encryption key; see that repository's README.
The website rejects an older one-time pricing contract before opening checkout.
The listed price remains visible when billing is unavailable, but checkout is disabled.

Website tests do not connect to PostgreSQL. They include pricing-contract and cookie,
CSRF, webhook and redirect checks. Some catalogue tests bind a local HTTP socket.
