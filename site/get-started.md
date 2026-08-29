# Get started

## Run the whole thing

You need Docker and one credential: set `GL3_NPM_TOKEN` in `.env`, the npm.gl3.dev
registry token the plugins installer uses.

```bash
git clone https://github.com/GL3PBBG/GL3.git
cd GL3
docker compose --profile app up
```

That brings up Postgres, Redis, a one shot migration container, the game server with
starter content seeded, the web client, and a router that keeps the browser same origin.

Open <http://localhost:8080> and register. The first player to register becomes the
administrator.

That default boot is the `gl3` hybrid, all twenty-seven bundled plugins with curated
content. `GL3_PROFILE` picks the other three modes: `v2` is the faithful Gangster
Legends V2 port, `mccodes` is the MCCodes-parity game, and `framework` is the engine on
its own, with the eight game-agnostic plugins and none of the gameplay:

```bash
GL3_PROFILE=framework docker compose --profile app up
```

Gameplay plugins can be added back one at a time with `PLUGIN_IDS`. See
[Game modes](https://docs.gl3.dev/operators/framework-profile.html).

By default the email verification link is printed to the logs rather than sent:

```bash
docker compose --profile app logs server
```

## Run it somewhere real

Set `GL3_PUBLIC_ORIGIN` to the URL players will reach the game at, since it feeds the
CORS allowlist that the WebSocket gateway also checks, and set `GL3_PORT` if 8080 is
taken. Nothing else needs editing.

## Bring an existing game across

`gl3-migrate` moves an existing Gangster Legends V2 or openPBBG game in one command,
players and passwords included. See
[Migrating from V2 or openPBBG](https://docs.gl3.dev) in the documentation.

## Where to go next

- [Tutorials](https://docs.gl3.dev/tutorials/getting-started) to learn the system
- [Create a plugin](https://docs.gl3.dev/guides/create-a-plugin) to extend it
- [Plugins](/plugins.html) to see what premium unlocks
