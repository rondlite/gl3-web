---
layout: home

hero:
  # No name field: the lockup below already says GL3, so the tagline gets the h1.
  text: The next generation engine for persistent browser games
  image:
    src: /gl3-logo.webp
    alt: GL3, a PBBG game engine
  tagline: Typed events over WebSockets, an append-only ledger under every balance movement, and plugins that own their tables and migrations. One command boots the whole thing; one more brings your V2, openPBBG or MCCodes game across.
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
  - title: Realtime by architecture
    details: Every outcome is a typed event, validated at the boundary, published after the transaction commits and fanned out by audience over WebSockets. The client renders it live.
  - title: Migrates V2, openPBBG and MCCodes v2
    details: gl3-migrate carries an existing game across in one command, players and passwords included. Legacy passwords upgrade to argon2id on first login.
  - title: Built to be extended
    details: A first party plugin SDK, a typed event system, and plugins that own their own tables and migrations. Boots complete in one command; the first player becomes administrator.
---

## Two faces, one codebase

`GL3_PROFILE` decides which of the twenty bundled plugins load at boot.

`full` is the default and it is the gangster game. All twenty load, including the twelve
gameplay ones: crimes, combat, gangs, travel, bullets, organised crime, bounties,
detectives, car theft, properties, casino and blackjack. Jail and hospital come with it
too, as core routes rather than plugins.

`framework` is the engine on its own. It loads the eight game-agnostic plugins, which are
ranks, notifications, news, bank, mail, forum, inventory and membership. That is
[openPBBG](https://github.com/ChristopherDay/openPBBG)'s module list, one GL3 plugin each.

```bash
GL3_PROFILE=framework docker compose --profile app up
```

Gameplay is not lost when you choose `framework`, it is opt-in. Add pieces back one at a
time with the same variable that selects any optional plugin:

```bash
GL3_PROFILE=framework PLUGIN_IDS=crimes
```

The MCCodes mechanics ship the same way. An anchor plugin, `mccodes-attributes`, declares
the energy, brave and will pools with MCCodes' own numbers, and gym, houses, progression,
education, jobs and temple build on it. All seven are bundled but load only when selected,
so a game that never asks for them is untouched by them.

[The framework profile](https://docs.gl3.dev/operators/framework-profile.html) covers what
each profile registers and how plugin requirements resolve.

## Why move off what you are running

The GL2 and MCCodes lineage is aging in ways that are specific rather than vague, and
openPBBG inherits the same two faults. Both bite hardest on the games that have been
running longest.

Money is stored in `int(11)`, which stops at roughly 2.14 billion. A long running game
reaches that ceiling and the numbers stop meaning anything. GL3 stores money in bigint.

Passwords are hashed with bare sha256 and no work factor, which is not a defensible
position for an account database in 2026. GL3 uses argon2id.

Relationships between tables are conventions rather than constraints, so orphaned rows
accumulate quietly. GL3 uses real foreign keys.

None of that requires starting over. `gl3-migrate` moves an existing V2 or openPBBG game
across in a single command, and it brings the players and their passwords with it.

[Read the full comparison](https://docs.gl3.dev/gl3-vs-v2.html)

## Built on things that hold up

Node 22, TypeScript in strict mode, Fastify, PostgreSQL 16, and Redis 7. Real migrations,
real tests, and a documented plugin API.

If you would rather read code than marketing copy, the engine is on
[GitHub](https://github.com/rondlite/GL3) and the documentation is at
[docs.gl3.dev](https://docs.gl3.dev).
