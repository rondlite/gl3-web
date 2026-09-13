# Premium pricing decision — 13 September 2026

Accepted commercial terms from the owner. This replaces the one-time purchase
assumption in the initial checkout implementation and earlier storefront plans.

## Offer

| Item | Decision |
| --- | --- |
| First year | €69, VAT included |
| Renewal | €49 per year, VAT included |
| Billing | Annual subscription; renews automatically unless cancelled |
| Returning after a lapse | €49 for a new year from renewal; no catch-up charges |
| Licence | Per person, unlimited games owned by that person |
| Client hosting / agency use | Separate conversation; not included in the personal licence |
| Price protection | Existing buyers retain their €49 annual renewal rate, including after a lapse |
| Launch promotion | None; no founders tier, countdown or early-bird pricing |
| Billing provider | Stripe Checkout + Billing, with Stripe Tax for inclusive VAT |
| Mail | Resend |
| Support channel | Discord: https://discord.gg/6U8ezKE8T |

The first-year price matches the GL Premium anchor. A lower renewal rewards continuing
to subscribe without introducing another tier. Do not publish competitor positioning,
internal margin estimates or the pricing rationale as customer-facing copy.

## Included access

Active subscribers receive every premium plugin, new plugins, updates and scoped
Premium support. Use a paid-through timestamp for registry entitlements. An unpaid
renewal must not extend access merely because a subscription object still exists.

Cancellation stops the next renewal; it does not remove the remainder of a paid year.
Lapsing removes registry access, updates, new plugins and support. It does not disable
installed plugins or invalidate the right to keep using the versions already installed.
Customers need to retain their own package copies if they want to reinstall while lapsed.

The pricing FAQ must include this sentence verbatim:

> Keep everything you installed, lose updates, new plugins and support. Renew any time for €49 and you're current again.

Renewal eligibility belongs to the verified buyer account and survives a lapse. Never
trust a browser-provided returning-customer flag or an unverified email to determine
price or account ownership. A buyer whose original purchase was fully refunded is not
established as a paid returning customer by that refunded purchase alone.

## Support

Includes installation and upgrade help, plus investigation and fixes for bugs in the
GL3 engine and official premium plugins. Target: an initial response within two business
days. This is not an SLA or a two-day resolution guarantee. No custom development,
game-building service, third-party code maintenance or hosting infrastructure support.
Support ends with the paid subscription term.

Use exactly one support channel: [Discord](https://discord.gg/6U8ezKE8T).
The owner confirmed this channel and link. Resend handles transactional purchase emails;
it is not a second support channel.

## Optional AI

Every plugin works without an AI endpoint. Fixer and newspaper use template fallbacks;
families uses its built-in instinct policy. An optional OpenAI-compatible endpoint can
supply generated content or model-driven decisions. Hosted-provider usage is separate
from Premium; a customer can also host their own endpoint.

Checked against the local README files for gl3-plugin-fixer, gl3-plugin-newspaper and
gl3-plugin-families. Do not claim families' non-model behaviour is a text template or
say that any of these plugins requires a paid AI provider.

## Billing implementation and launch dependencies

The annual implementation uses Stripe Checkout in subscription mode. Configure a
€49 annual VAT-inclusive price and a €20 VAT-inclusive one-time first-year supplement.
Stripe includes the supplement on the first invoice only, so first-year checkout totals
€69 and subsequent invoices total €49 without a scheduled price mutation. Returning
buyers sign in and omit the supplement.

Buyer records retain their annual Price ID and renewal amount across a lapse. Paid
invoices establish access periods; refund records remove only the refunded periods.
Cancellation is handled through a Stripe portal configured for period-end cancellation,
with price and quantity changes disabled. Resend sends an email for each paid invoice.

The website validates the advertised annual terms before opening checkout and rejects
the previous one-time API response. This catches mismatched site/API deployments.

The owner selected **Stripe**. This integration uses ordinary Stripe Checkout and Tax;
it does not enroll the business in Stripe Managed Payments or make Stripe the merchant
of record. Stripe Tax configuration and the business's applicable tax registrations
must be set up before launch. There is no claim that a merchant of record is absorbing
tax or filing obligations.

Implementation references: [mixed one-time and recurring Checkout items](https://docs.stripe.com/api/checkout/sessions/create#line_items),
[inclusive tax behaviour](https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior).

Acceptance requirements:

- €69 for the initial year and €49 annually thereafter, with no VAT added on top.
- €49 returning-customer checkout after a lapse, tied to an authenticated account.
- Persisted buyer pricing terms so future price changes do not migrate existing buyers.
- Signed, idempotent paid-invoice processing that extends access only for paid periods.
- Cancellation management and visible next renewal / paid-through dates.
- Failed payments, delayed or out-of-order events, refunds and resubscription without
  granting unearned access or creating duplicate active subscriptions.
- Resend messages showing the actual paid period, renewal price and support contact.

Prices should be configured as VAT-inclusive in the selected billing product. The
owner’s rough net figures are planning estimates, not guaranteed receipts; do not put
those estimates in the storefront.

Release validation on 13 September 2026: both builds pass, all 106 website tests
pass, and all 131 API tests pass against the isolated
`gl3_store_premium_release_20260913` database. This includes first purchase, invoice
renewal, lapse and authenticated €49 return, refunds, concurrent fulfilment and
Resend delivery retries. The returning-customer fixture now uses a distinct Stripe
Session ID and verifies access through the new paid year without minting another token.

Live Stripe/Resend delivery still needs the owner's deployment smoke test. Apply the
store API migrations with `node dist/migrate.js` before testing a purchase on the new
image. Production database changes were not run by this local validation.
