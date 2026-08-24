# Get started

## Run the whole thing

You need Docker. Nothing else.

```bash
git clone https://github.com/rondlite/GL3.git
cd GL3
docker compose --profile app up
```

That brings up Postgres, Redis, a one shot migration container, the game server with
starter content seeded, the web client, and a router that keeps the browser same origin.

Open <http://localhost:8080> and register. The first player to register becomes the
administrator.

By default the email verification link is printed to the logs rather than sent:

```bash
docker compose --profile app logs server
```

## Run it somewhere real

Set `GL3_PUBLIC_ORIGIN` to the URL players will reach the game at, since it feeds the
CORS allowlist that the WebSocket gateway also checks, and set `GL3_PORT` if 8080 is
taken. Nothing else needs editing.

## Bring a V2 game across

`gl3-migrate` moves an existing Gangster Legends V2 game in one command, players and
passwords included. See [Migrating from V2](https://docs.gl3.dev) in the documentation.

## Where to go next

- [Tutorials](https://docs.gl3.dev/tutorials/getting-started) to learn the system
- [Create a plugin](https://docs.gl3.dev/guides/create-a-plugin) to extend it
- [Plugins](/plugins.html) to see what premium unlocks
