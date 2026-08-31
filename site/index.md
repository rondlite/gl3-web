---
layout: home

hero:
  # No name field: the lockup below already says GL3, so the tagline gets the h1.
  text: The next generation platform for persistent browser games
  image:
    src: /gl3-logo.webp
    alt: GL3, a PBBG game engine
  tagline: A complete game and the platform under it. Typed events over WebSockets, an append-only ledger under every balance movement, plugins that own their tables and migrations, and an admin that authors the content. One command boots the whole thing, under your name and your logo.
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
    details: Every outcome is a typed event, validated at the boundary, committed in the same transaction as the facts it describes, then fanned out by audience over WebSockets. The client renders it live.
  - title: Your game, not a demo of ours
    details: Set the game name, bind your logos, pick a theme, and author the crimes, items, courses and art from the admin. GL3 disappears from the interface; your game is what players see.
  - title: Built to run live
    details: An anti-bot toolkit that surfaces multi-account clusters and challenges suspects, role-scoped admin grants, and content you can tune while the game is up.
  - title: Migrates V2, openPBBG and MCCodes v2
    details: gl3-migrate carries an existing game across in one command, players and passwords included. Legacy passwords upgrade to argon2id on first login.
---

## Four faces, one codebase

`GL3_PROFILE` decides which of the twenty-seven bundled plugins load at boot. Four
values parse.

`gl3` is the default and the flagship hybrid. All twenty-seven load: the game-agnostic
framework set, the twelve V2 gameplay plugins, and the MCCodes family, with curated
content on top. Jail and hospital come with every gameplay profile too, as core routes
rather than plugins.

`v2` is the faithful Gangster Legends V2 port. Framework plus the twelve gameplay
plugins: crimes, combat, gangs, travel, bullets, organised crime, bounties, detectives,
car theft, properties, casino and blackjack.

`mccodes` is the MCCodes-parity game. An anchor plugin, `mccodes-attributes`, declares
the energy, brave and will pools with MCCodes' own numbers, and gym, houses, progression,
education, jobs and temple build on it. The profile also pulls in crimes, combat, travel
and detectives, where its mechanics live.

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

Cross-plugin requirements are declared on the manifests and enforced at boot, so a
selection that would not run refuses to start instead of half working.

[Game modes](https://docs.gl3.dev/operators/framework-profile.html) covers what
each profile registers and how plugin requirements resolve.

## Make it yours

The engine ships as GL3 and stops being GL3 the moment you rename it. The game name is a
setting, the login and header logos are bindable slots, and a bound logo replaces the
wordmark everywhere down to the page title. Players never see the platform's name unless
you keep it.

Content is authored, not coded. Crimes and their success formulas, items and their
effects, courses, jobs, houses and the art on each of them are edited from the admin
while the game is running. The starter content seeded at first boot is a working game to
reshape, not a template to admire.

## Built for the part after launch

Running a persistent browser game means moderating one. GL3's admin is granted per
module to roles you define, so a moderator sees exactly the sections you hand them.

The anti-bot toolkit is built in rather than bolted on. Signup and last-seen addresses
are recorded, an admin section surfaces multi-account clusters and suspect accounts, a
challenge gate lets you interrupt a suspect with a question only a human answers, and
same-IP handover blocks stop the obvious asset-funnelling moves. All of it is opt-in and
invisible to ordinary players.
[The operator guide](https://docs.gl3.dev/operators/anti-bot.html) covers each layer.

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
[GitHub](https://github.com/GL3PBBG/GL3) and the documentation is at
[docs.gl3.dev](https://docs.gl3.dev).
