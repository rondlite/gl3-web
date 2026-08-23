---
layout: home

hero:
  name: GL3
  text: Run your own gangster game
  tagline: A modern engine for text based gangster games, and a one command migration path off Gangster Legends V2.
  actions:
    - theme: brand
      text: Get started
      link: /get-started.html
    - theme: alt
      text: Browse plugins
      link: /plugins.html
    - theme: alt
      text: See it running
      link: https://game.gl3.dev

features:
  - title: Boots in one command
    details: Postgres, Redis, the server, the web client and a router come up together from published images. Register, and the first player becomes administrator.
  - title: Brings your V2 game with it
    details: gl3-migrate carries an existing game across in one command, players and passwords included.
  - title: Built to be extended
    details: A first party plugin SDK, a typed event system, and plugins that own their own tables and migrations.
---

## Why move off V2

The GL2 and MCCodes lineage is aging in ways that are specific rather than vague, and
both of them bite the games that have been running longest.

Money is stored in `int(11)`, which stops at roughly 2.14 billion. A long running game
reaches that ceiling and the numbers stop meaning anything. GL3 stores money in bigint.

Passwords are hashed with bare sha256 and no work factor, which is not a defensible
position for an account database in 2026. GL3 uses argon2id.

Relationships between tables are conventions rather than constraints, so orphaned rows
accumulate quietly. GL3 uses real foreign keys.

None of that requires starting over. `gl3-migrate` moves an existing V2 game across in a
single command, and it brings the players and their passwords with it.

[Read the full comparison](https://docs.gl3.dev/gl3-vs-v2.html)

## Built on things that hold up

Node 22, TypeScript in strict mode, Fastify, PostgreSQL 16, and Redis 7. Real migrations,
real tests, and a documented plugin API.

If you would rather read code than marketing copy, the engine is on
[GitHub](https://github.com/rondlite/GL3) and the documentation is at
[docs.gl3.dev](https://docs.gl3.dev).
