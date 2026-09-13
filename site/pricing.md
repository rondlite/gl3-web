# Premium

Every premium plugin, updates and help running your game. One personal subscription,
for any number of games you own.

<PremiumPurchase />

## What’s included

- The whole [`@gl3-plugins` catalogue](/plugins.html), including new plugins released
  while your subscription is active.
- Engine and plugin updates, including bug fixes.
- Help installing and upgrading the engine and premium plugins.
- Any number of your own games, on your hardware or someone else’s.

The licence is per person, not per server. There is no seat count or activation step
at install time. Hosting for clients? [Get in touch](https://github.com/GL3PBBG/GL3/discussions)
about agency licensing.

## Premium support

Premium support covers installation and upgrade help, plus bugs in the GL3 engine and
official premium plugins. Report a bug and we’ll investigate it and work on a fix.

Support is provided through our [Discord server](https://discord.gg/6U8ezKE8T).
We aim to respond within **2 business days**. This is a response target, not an SLA
or a promise to resolve every issue within two days.

Custom development, building your game for you, and maintaining third-party code or
your hosting infrastructure are outside the scope. Premium support ends when your
subscription lapses.

## AI is optional

Every plugin works out of the box with no AI dependency. Fixer and newspaper use
built-in templates, and families runs on built-in instincts when no model is configured.

Connect fixer, newspaper or families to an OpenAI-compatible endpoint—hosted or your
own—to add live generated content or model-driven decisions. If you choose a paid
provider, its usage charges are separate from Premium.

## Frequently asked questions

### What happens if my subscription lapses?

Keep everything you installed, lose updates, new plugins and support. Renew any time for €49 and you're current again.

Your installed plugins keep running. Private registry access ends when your paid year
ends, so you can’t download or reinstall premium packages from the registry until you
renew. Keep your own copies of the packages you use.

### Do I pay €69 again if I come back later?

No. Your first year is €69. Every renewal is €49 for another year, even after a break.
You don’t pay for the time you were away.

### Does it renew automatically?

Yes. After the first year, your subscription renews annually at €49. Cancel before
your next renewal to stop future charges. Your access and support continue until the
end of the year you’ve paid for.

### Is VAT included?

Yes. €69 for the first year and €49 for each renewal are the VAT-inclusive prices.
VAT isn’t added on top at checkout.

### Will my renewal price go up?

Existing subscribers keep their €49 annual renewal rate if the price for new customers
increases. That rate also applies when you return after a lapse.

### Do I need Premium to run a game?

No. The engine, plugin SDK, shared types and documentation stay free and open source.
You can run a complete game without buying anything. Premium adds the plugin catalogue
and the support described above.

### How do I install premium plugins?

Your purchase gives you an npm token for the private registry. Your credentials are
shown after checkout and sent by email. GL3 includes a `.npmrc` that configures the
plugin registry. From your GL3 project directory, sign in and install the plugins
you want:

```bash
npm login --registry https://npm.gl3.dev --auth-type=legacy
npm install @gl3-plugins/market
```

Use your `gl3_` token as the password when npm asks you to sign in.
