# Get started

The GL3 engine and its 27 bundled plugins are free. **You don’t need a key or a
Premium subscription to run your game.** A registry token is needed only when you
choose to install premium plugins.

## Run the published containers

You need Docker with Docker Compose. You can use the published images without Git,
Node.js, or a source checkout. Download the Compose file and its router configuration
into a new directory:

```bash
mkdir -p my-gl3-game/deploy
cd my-gl3-game
curl -fL https://raw.githubusercontent.com/GL3PBBG/GL3/main/docker-compose.yml -o docker-compose.yml
curl -fL https://raw.githubusercontent.com/GL3PBBG/GL3/main/deploy/nginx.conf -o deploy/nginx.conf
docker compose --profile app up -d
```

This starts PostgreSQL, Redis, database migrations, the game server, the web client
and the router. The optional plugin installer skips its work when no extra plugins
are selected.

Open <http://localhost:8080> and register. The first player to register becomes the
administrator. By default, email verification links appear in the server logs:

```bash
docker compose --profile app logs server
```

Your database lives in a Docker volume and uploaded art in `var/assets` beside the
Compose file. Keep these when updating your game.

### Prefer a source checkout?

Clone the repository instead of downloading the two files. The same command runs the
published containers; cloning alone does not build your local source changes.

```bash
git clone https://github.com/GL3PBBG/GL3.git
cd GL3
docker compose --profile app up -d
```

To develop and run GL3 from source, follow the
[development quick start](https://github.com/GL3PBBG/GL3#quick-start-from-source).

## Choose your game

The default `gl3` profile loads all 27 bundled plugins with starter content. Set
`GL3_PROFILE` in a `.env` file beside your Compose file to choose another starting point:

| Profile | What you start with |
| --- | --- |
| `gl3` | The full GL3 hybrid game. |
| `v2` | The Gangster Legends V2 gameplay set. |
| `mccodes` | MCCodes-style pools, training and progression. |
| `framework` | Eight game-agnostic plugins, ready for your own gameplay. |

For example, put this in `.env`, then run the Compose command again:

```dotenv
GL3_PROFILE=framework
```

See [Game modes](https://docs.gl3.dev/operators/framework-profile.html) for profile
contents and how to add bundled gameplay plugins individually.

## Add Premium when you want it

[Premium](/pricing.html) adds the premium plugin catalogue and support. Once you have
your registry token, add the packages you want and your token to `.env`:

```dotenv
PLUGIN_PACKAGES=@gl3-plugins/market
GL3_NPM_TOKEN=your_gl3_token_here
```

Then run `docker compose --profile app up -d` again. The installer downloads the
selected packages and the server loads them at startup. Use a comma-separated list
for multiple plugins; keep the token private.

Leave both variables unset for the free game. See
[Installing plugins](https://docs.gl3.dev/operators/installing-plugins.html) for plugin
requirements, updates and other deployment options.

## Put it on your own domain

Set the public URL and listening port in `.env`, then run the Compose command again:

```dotenv
GL3_PUBLIC_ORIGIN=https://game.example.com
GL3_PORT=8080
```

Point your HTTPS reverse proxy or tunnel at the router’s port. The public origin also
sets the allowed browser origin and the links in outgoing email.

For public hosting, follow the [operator guide](https://docs.gl3.dev/operators/index.html)
for database access, real email delivery and trusted proxy settings. The repository
also provides a [Compose override that removes database host ports](https://github.com/GL3PBBG/GL3/blob/main/deploy/compose.no-db-ports.yml).

## Make it your game

Set your game name, logos and theme in the admin. Author crimes, items, courses, jobs,
houses and their artwork while the game runs. Schedule rounds and configure prize
points as your community grows.

Already running Gangster Legends V2, openPBBG or MCCodes v2? The
[migration guide](https://docs.gl3.dev/operators/index.html) explains how to bring
players and their passwords across.

## Where to go next

- [Play the demo](https://game.gl3.dev) to try the game
- [Browse plugins](/plugins.html) to see what Premium adds
- [Create a standalone plugin](https://docs.gl3.dev/guides/create-a-standalone-plugin.html) to build your own features
- [Read the docs](https://docs.gl3.dev) for deployment and development guides
