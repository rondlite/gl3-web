# gl3-web

The GL3 website: [gl3.dev](https://gl3.dev).

Four pages built with VitePress, served by a small Hono server that also hosts
`/api/plugins`. That route is the only thing holding `INTERNAL_API_KEY`, so the browser
never sees it and never talks to store-api directly.

```
browser ──> gl3-web ──> gl3-store-api /v1/catalog/packages
```

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

`STORE_API_URL` and `INTERNAL_API_KEY` are required. A site with no catalogue source has
a permanently broken plugins page, so it refuses to start rather than serving one.

## Failure behaviour

The catalogue is cached in memory for `CATALOG_CACHE_MS`. If store-api becomes
unreachable, the last good copy keeps being served. If it is unreachable and nothing has
been cached yet, `/api/plugins` returns `200` with an empty list and `available: false`,
and the page says the catalogue is temporarily unreachable.

The site never fails to load because store-api is down.

## Deployment

`npm run build && npm start`, or the image published to `ghcr.io/rondlite/gl3-web` on
every push to the default branch. gl3-web needs network reach to store-api and the same
`INTERNAL_API_KEY`.
