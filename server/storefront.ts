import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';

export type StorefrontConfig = { url: string; key: string; origin: string; fetch?: typeof fetch };
const credentials = z.object({ username: z.string().min(1).max(100), token: z.string().regex(/^gl3_[A-Za-z0-9_-]{43}$/) });
const proofSchema = z.object({ orderId: z.string().regex(/^[a-f0-9]{48}$/), claimSecret: z.string().regex(/^[a-f0-9]{64}$/) });
const checkoutSchema = z.union([z.object({ completed: z.literal(true) }), z.object({ url: z.string().url().refine(url => new URL(url).origin === 'https://checkout.stripe.com') })]);
const profileSchema = z.object({ username: z.string(), premium: z.boolean() });
// The advertised annual terms are a contract. An older one-time API must
// never open a checkout underneath this page, even via a direct POST.
const priceSchema = z.object({
  billing: z.literal('annual'), firstYearAmount: z.literal(6900),
  renewalAmount: z.literal(4900), currency: z.literal('eur'), vatIncluded: z.literal(true),
});
const billingSchema = z.object({ renewalEligible: z.boolean(), paidUntil: z.string().datetime().nullable(),
  renewalAmount: z.number().int().positive().optional(), subscription: z.object({ status: z.string().max(40), cancelAtPeriodEnd: z.boolean(), renewsAt: z.string().datetime().nullable() }).nullable() });
const statusSchema = z.object({ paidUntil: z.string().datetime().nullable().optional(), state: z.enum(['pending', 'ready', 'expired', 'refunded']), canClaim: z.boolean().optional(), emailSent: z.boolean().optional() });

class StoreError extends Error {
  constructor(public code: string, public status: 400 | 401 | 404 | 409 | 410 | 503) { super(code); }
}

export function createStorefront(config: StorefrontConfig) {
  const app = new Hono();
  const fetcher = config.fetch ?? fetch;
  const origin = new URL(config.origin).origin;
  const secure = origin.startsWith('https:');
  const cookieKey = Buffer.from(hkdfSync('sha256', config.key, origin, 'gl3-storefront-cookies-v1', 32));
  const cookieOptions = { httpOnly: true, secure, sameSite: 'Lax' as const, path: '/' };
  const cookieName = (kind: string) => `${secure ? '__Host-' : ''}gl3_${kind}`;

  function writeCookie(c: Context, kind: string, value: unknown, seconds: number) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cookieKey, iv);
    cipher.setAAD(Buffer.from(kind));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ value, expires: Date.now() + seconds * 1000 })), cipher.final()]);
    setCookie(c, cookieName(kind), Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url'), { ...cookieOptions, maxAge: seconds });
  }
  function readCookie(c: Context, kind: string): unknown {
    try {
      const bytes = Buffer.from(getCookie(c, cookieName(kind)) ?? '', 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', cookieKey, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(kind));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const body = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
      return body.expires > Date.now() ? body.value : undefined;
    } catch { return undefined; }
  }
  function clearCookie(c: Context, kind: string) { deleteCookie(c, cookieName(kind), cookieOptions); }

  async function upstream(path: string, body?: unknown, raw?: { body: string; signature: string }) {
    const response = await fetcher(`${config.url}${path}`, {
      method: body !== undefined || raw ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json',
        ...(raw ? { 'stripe-signature': raw.signature } : {}) },
      ...(raw ? { body: raw.body } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) {
      const codes = new Set(['invalid_credentials', 'order_not_found', 'checkout_expired', 'not_ready',
        'credentials_already_delivered', 'invalid_signature', 'invalid_request', 'email_required',
        'sign_in_required', 'subscription_exists', 'checkout_in_progress']);
      const error = z.object({ error: z.string() }).safeParse(data).data?.error;
      const code = error && codes.has(error) ? error : 'store_unavailable';
      const status = [400, 401, 404, 409, 410].includes(response.status) ? response.status as 400 | 401 | 404 | 409 | 410 : 503;
      throw new StoreError(code, status);
    }
    return data;
  }

  app.use('*', bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ error: 'payload_too_large' }, 413) }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.method === 'POST' && c.req.path !== '/api/premium/webhook') {
      if (c.req.header('origin') !== origin) return c.json({ error: 'invalid_origin' }, 403);
      if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') {
        return c.json({ error: 'invalid_request' }, 400);
      }
    }
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof StoreError) return c.json({ error: err.code }, err.status);
    return c.json({ error: 'store_unavailable' }, 503);
  });
  app.get('/premium/price', async c => c.json(priceSchema.parse(await upstream('/v1/premium/price'))));
  app.post('/premium/start', async c => {
    priceSchema.parse(await upstream('/v1/premium/price'));
    const body = z.object({ email: z.string().email().max(254).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    const auth = credentials.safeParse(readCookie(c, 'account')).data;
    if (!auth && !body.data.email) return c.json({ error: 'email_required' }, 400);
    let proof = proofSchema.safeParse(readCookie(c, 'checkout')).data;
    if (!proof) proof = { orderId: randomBytes(24).toString('hex'), claimSecret: randomBytes(32).toString('hex') };
    // Set before calling Stripe: a timed-out response must be retryable using
    // the same durable order and Stripe idempotency key.
    writeCookie(c, 'checkout', proof, 7 * 86400);
    try {
      return c.json(checkoutSchema.parse(await upstream('/v1/premium/start', { ...proof, ...(auth ? { auth } : { email: body.data.email }) })));
    } catch (err) {
      if (err instanceof StoreError && err.code === 'checkout_expired') clearCookie(c, 'checkout');
      throw err;
    }
  });
  for (const operation of ['status', 'claim'] as const) {
    app.post(`/premium/${operation}`, async c => {
      const proof = proofSchema.safeParse(readCookie(c, 'checkout'));
      if (!proof.success) return c.json({ error: 'order_not_found' }, 404);
      const result = await upstream(`/v1/premium/${operation}`, proof.data);
      if (operation === 'status') return c.json(statusSchema.parse(result));
      const claimed = credentials.parse(result);
      writeCookie(c, 'account', claimed, 8 * 3600);
      return c.json(claimed);
    });
  }
  app.post('/premium/webhook', async c => {
    await upstream('/v1/premium/webhook', undefined, { body: await c.req.text(), signature: c.req.header('stripe-signature') ?? '' });
    return c.json({ received: true });
  });
  app.post('/account/login', async c => {
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_credentials' }, 401);
    const profile = profileSchema.parse(await upstream('/v1/account/profile', parsed.data));
    writeCookie(c, 'account', parsed.data, 8 * 3600);
    return c.json(profile);
  });
  app.get('/account/profile', async c => {
    const auth = credentials.safeParse(readCookie(c, 'account'));
    if (!auth.success) return c.json({ error: 'invalid_credentials' }, 401);
    return c.json(profileSchema.parse(await upstream('/v1/account/profile', auth.data)));
  });
  app.get('/account/billing', async c => {
    const auth = credentials.safeParse(readCookie(c, 'account'));
    if (!auth.success) return c.json({ error: 'invalid_credentials' }, 401);
    return c.json(billingSchema.parse(await upstream('/v1/premium/billing', auth.data)));
  });
  app.post('/account/portal', async c => {
    const auth = credentials.safeParse(readCookie(c, 'account'));
    if (!auth.success) return c.json({ error: 'invalid_credentials' }, 401);
    const result = z.object({ url: z.string().url().refine(url => new URL(url).origin === 'https://billing.stripe.com') })
      .parse(await upstream('/v1/premium/portal', auth.data));
    return c.json(result);
  });
  app.post('/account/logout', c => { clearCookie(c, 'account'); return c.json({ ok: true }); });
  app.post('/account/rotate-token', async c => {
    const auth = credentials.safeParse(readCookie(c, 'account'));
    if (!auth.success) return c.json({ error: 'invalid_credentials' }, 401);
    const replacement = credentials.parse(await upstream('/v1/account/rotate-token', auth.data));
    writeCookie(c, 'account', replacement, 8 * 3600);
    return c.json(replacement);
  });
  return app;
}
