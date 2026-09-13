<script setup>
const gameplay = [
  { title: 'Crime and combat', text: 'Crimes, organised heists, car theft, bounties and detectives. Firearms and melee give players different ways to settle a rivalry.' },
  { title: 'An economy players live in', text: 'Banking, inventory, properties and travel connect earning, spending and ownership. Every balance change has a ledger entry.' },
  { title: 'Progression and community', text: 'Training, education, jobs and ranks give players long-term goals. Gangs, mail and forums give them people to share those goals with.' },
  { title: 'Competition beyond combat', text: 'Casino games and multiplayer blackjack sit alongside seasonal leaderboards. Schedule rounds and award points to the winners.' },
]
const profiles = [
  { id: 'gl3', title: 'The full GL3 game', text: 'The default. All 27 bundled plugins combine the gangster game, character progression and community systems.' },
  { id: 'v2', title: 'Gangster Legends V2', text: 'The familiar crime, combat, gang and casino loops, running on the modern engine.' },
  { id: 'mccodes', title: 'The MCCodes game', text: 'Energy, brave and will, with gym training, houses, education, jobs and level progression.' },
  { id: 'framework', title: 'Build your own genre', text: 'Accounts, ranks, banking, mail, forums and inventory. Add the gameplay that fits your world.' },
]
const plugins = [
  { id: 'market', title: 'Market', text: 'Player-to-player trade with escrow.' },
  { id: 'territory', title: 'Territory', text: 'Gang turf, rackets and contested districts.' },
  { id: 'families', title: 'Families', text: 'NPC crime families that act in your world.' },
  { id: 'fixer', title: 'Fixer', text: 'A contract broker for every town.' },
  { id: 'newspaper', title: 'Newspaper', text: 'Editions drawn from real game events.' },
  { id: 'holdem', title: 'Texas Hold’em', text: 'Player-versus-player poker in the casino.' },
]
</script>

<template>
  <div class="gl3-home">
    <section class="gl3-home-section" aria-labelledby="gameplay-title">
      <p class="gl3-eyebrow">A playable world from the first boot</p>
      <h2 id="gameplay-title">Give players something to build on.</h2>
      <p class="gl3-home-intro">The free engine includes a complete game with connected systems. Choose what belongs in your world, then tune its content and rules.</p>
      <div class="gl3-home-grid">
        <article v-for="feature in gameplay" :key="feature.title" class="gl3-home-card">
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.text }}</p>
        </article>
      </div>
    </section>

    <section class="gl3-home-premium gl3-home-section" aria-labelledby="premium-title">
      <div class="gl3-home-split">
        <div>
          <p class="gl3-eyebrow">Keep expanding your world</p>
          <h2 id="premium-title">More game. One Premium subscription.</h2>
          <p>Add trade, turf wars, NPC families and more from the growing plugin catalogue. Premium includes every premium plugin, new releases during your subscription, updates and Discord support.</p>
        </div>
        <div class="gl3-home-price">
          <p><strong>€69</strong> first year</p>
          <p>Then <b>€49 / year</b>. VAT included.</p>
          <p class="gl3-home-small">One person. Any number of your own games.</p>
          <a class="gl3-home-button" href="/pricing.html">See Premium and support</a>
        </div>
      </div>
      <div class="gl3-home-plugin-grid">
        <a v-for="plugin in plugins" :key="plugin.id" :href="`/plugins/gl3-plugins/${plugin.id}.html`" target="_self" class="gl3-home-plugin">
          <h3>{{ plugin.title }} <span aria-hidden="true">↗</span></h3>
          <p>{{ plugin.text }}</p>
        </a>
      </div>
      <p class="gl3-home-small">AI is optional. Fixer and newspaper have template fallbacks; families has built-in instincts. Connect your own model endpoint if you want to use AI.</p>
      <p class="gl3-home-small">Installed plugins keep running if you leave. Downloads, updates, new plugins and support require an active subscription. <a href="/plugins.html">Browse the full catalogue →</a></p>
    </section>

    <section class="gl3-home-section gl3-home-split" aria-labelledby="operator-title">
      <div>
        <p class="gl3-eyebrow">Your name above the door</p>
        <h2 id="operator-title">Build the game. Run the community.</h2>
        <p>Set your name, logos, theme and artwork. Author crimes, items, courses, jobs and houses from the admin while the game is running.</p>
        <p>Give moderators access to the modules they need. Investigate suspicious accounts with the anti-bot tools, schedule rounds, and set the prize points for each placing.</p>
        <a href="https://docs.gl3.dev/operators/index.html">Read the operator guides →</a>
      </div>
      <aside class="gl3-home-card gl3-home-foundation" aria-label="Engine foundations">
        <h3>Built for a persistent world</h3>
        <ul>
          <li>Live updates over WebSockets.</li>
          <li>Bigint balances and an append-only economy ledger.</li>
          <li>Argon2id passwords and role-scoped admin access.</li>
          <li>PostgreSQL migrations and tests against real services.</li>
          <li>Docker deployment on infrastructure you control.</li>
        </ul>
      </aside>
    </section>

    <section class="gl3-home-section" aria-labelledby="profiles-title">
      <p class="gl3-eyebrow">Four starting points</p>
      <h2 id="profiles-title">Choose the game you want to make.</h2>
      <div class="gl3-home-grid">
        <article v-for="profile in profiles" :key="profile.id" class="gl3-home-card">
          <code>{{ profile.id }}</code>
          <h3>{{ profile.title }}</h3>
          <p>{{ profile.text }}</p>
        </article>
      </div>
      <p class="gl3-home-small">Select a profile with <code>GL3_PROFILE</code>, then add optional plugins. <a href="https://docs.gl3.dev/operators/framework-profile.html">Compare profiles →</a></p>
    </section>

    <section class="gl3-home-section gl3-home-split" aria-labelledby="developers-title">
      <div>
        <p class="gl3-eyebrow">Make something we haven’t thought of</p>
        <h2 id="developers-title">Your next feature can be a plugin.</h2>
        <p>Scaffold a standalone package with <code>@gl3/create-plugin</code>. Add your own tables, migrations, routes, player pages and admin tools through the public SDK.</p>
        <p>The free <code>@gl3/client</code> package shares API calls, state and live events across custom React and React Native clients.</p>
        <a href="https://docs.gl3.dev/guides/create-a-standalone-plugin.html">Create your first plugin →</a>
      </div>
      <div>
        <p class="gl3-eyebrow">Bring your community with you</p>
        <h2>Already running a game?</h2>
        <p>Migrate from Gangster Legends V2, openPBBG or MCCodes v2. Bring players and their passwords across, with a dry run and migration report to check the move.</p>
        <p>Legacy password hashes upgrade when players sign in. The migration guides explain which data carries over and where the game mechanics change.</p>
        <a href="https://docs.gl3.dev/operators/index.html">Plan your migration →</a>
      </div>
    </section>

    <section class="gl3-home-start" aria-labelledby="start-title">
      <div>
        <h2 id="start-title">Put your world online.</h2>
        <p>The engine is free and open source. Start with the game, then make it yours.</p>
      </div>
      <div class="gl3-home-actions">
        <a class="gl3-home-button" href="/get-started.html">Get started</a>
        <a href="https://github.com/GL3PBBG/GL3">Read the source →</a>
      </div>
    </section>
  </div>
</template>
