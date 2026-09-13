import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';

const ORIGIN = 'https://gl3.dev';
const KEY = 'internal-secret-that-must-never-reach-a-browser';
const TOKEN = `gl3_${'a'.repeat(43)}`;
const TERMS = { billing: 'annual', firstYearAmount: 6900, renewalAmount: 4900, currency: 'eur', vatIncluded: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function harness() {
  const fetcher = vi.fn<typeof fetch>(async () => json(TERMS));
  const app = createApp({
    catalog: { get: async () => ({ available: true, plugins: [] }), getDetail: async () => ({ available: true, plugin: null }) },
    storefront: { url: 'http://store-api:8080', key: KEY, origin: ORIGIN, fetch: fetcher },
  });
  const post = (path: string, body: unknown = { email: 'buyer@example.com' }, cookie = '') => app.request(`${ORIGIN}/api/${path}`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  return { app, fetcher, post };
}
function cookieFrom(response: Response) { return response.headers.get('set-cookie')!.split(';')[0]!; }
function bodyOf(call: Parameters<typeof fetch>) { return JSON.parse(call[1]!.body as string); }
afterEach(() => vi.useRealTimers());

describe('annual pricing contract', () => {
  it('exposes only the agreed public terms', async () => {
    const { app, fetcher } = harness();
    fetcher.mockResolvedValueOnce(json({ ...TERMS, internalApiKey: KEY }));
    const response = await app.request(`${ORIGIN}/api/premium/price`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TERMS);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    { amount: 6900, currency: 'eur', formatted: '€69.00' },
    { ...TERMS, billing: 'one_time' },
    { ...TERMS, firstYearAmount: 9900 },
    { ...TERMS, renewalAmount: 6900 },
    { ...TERMS, vatIncluded: false },
    { ...TERMS, currency: 'usd' },
  ])('refuses incompatible pricing before any checkout is created (%j)', async terms => {
    const { fetcher, post } = harness();
    fetcher.mockResolvedValueOnce(json(terms));
    const response = await post('premium/start');
    expect(response.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://store-api:8080/v1/premium/price');
    expect(await response.json()).toEqual({ error: 'store_unavailable' });
  });
});

describe('storefront security boundaries', () => {
  it('rejects cross-origin, missing-origin and non-JSON mutations before calling the API', async () => {
    const { app, fetcher } = harness();
    for (const headers of [{ origin: 'https://evil.example', 'content-type': 'application/json' },
      { 'content-type': 'application/json' }, { origin: ORIGIN, 'content-type': 'text/plain' }]) {
      const response = await app.request(`${ORIGIN}/api/account/login`, { method: 'POST', headers, body: '{}' });
      expect([400, 403]).toContain(response.status);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forwards exact raw webhook bytes and signature without requiring browser origin', async () => {
    const { app, fetcher } = harness();
    fetcher.mockResolvedValueOnce(json({ received: true }));
    const raw = '{ "id": "evt_test",\n "type": "invoice.paid" }';
    const response = await app.request(`${ORIGIN}/api/premium/webhook`, { method: 'POST',
      headers: { 'stripe-signature': 't=123,v1=signed' }, body: raw });
    expect(response.status).toBe(200);
    const request = fetcher.mock.calls[0]![1]!;
    expect(request.body).toBe(raw);
    expect(request.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'stripe-signature': 't=123,v1=signed' });
    expect(request.redirect).toBe('error');
  });
  it('rejects an oversized webhook without sending it upstream', async () => {
    const { app, fetcher } = harness();
    const response = await app.request(`${ORIGIN}/api/premium/webhook`, { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sanitises upstream errors and exceptions', async () => {
    const { post, fetcher } = harness();
    fetcher.mockResolvedValueOnce(json({ error: `SQL error ${KEY} ${TOKEN}` }, 500));
    expect(await (await post('account/login', { username: 'buyer', token: TOKEN })).json()).toEqual({ error: 'store_unavailable' });
    fetcher.mockRejectedValueOnce(new Error(`Failed fetch with ${KEY}`));
    const response = await post('account/login', { username: 'buyer', token: TOKEN });
    expect(await response.text()).not.toContain(KEY);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('stores credentials in an authenticated encrypted HttpOnly cookie and strips extras from responses', async () => {
    const { post, fetcher, app } = harness();
    fetcher.mockResolvedValueOnce(json({ username: 'buyer', premium: true, token: TOKEN, groups: ['admin'] }));
    const response = await post('account/login', { username: 'buyer', token: TOKEN, userId: 'forged' });
    expect(await response.json()).toEqual({ username: 'buyer', premium: true });
    const header = response.headers.get('set-cookie')!;
    expect(header).toContain('__Host-gl3_account=');
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(header).toContain(attribute);
    expect(header).not.toContain(TOKEN);
    expect(bodyOf(fetcher.mock.calls[0]!)).toEqual({ username: 'buyer', token: TOKEN });
    fetcher.mockResolvedValueOnce(json({ username: 'buyer', premium: false }));
    const profile = await app.request(`${ORIGIN}/api/account/profile`, { headers: { cookie: cookieFrom(response) } });
    expect(await profile.json()).toEqual({ username: 'buyer', premium: false });
    expect(bodyOf(fetcher.mock.calls[1]!)).toEqual({ username: 'buyer', token: TOKEN });
  });
  it('refuses tampered and expired account cookies', async () => {
    const { post, fetcher, app } = harness();
    fetcher.mockResolvedValueOnce(json({ username: 'buyer', premium: true }));
    const login = await post('account/login', { username: 'buyer', token: TOKEN });
    const cookie = cookieFrom(login);
    const valueOffset = cookie.indexOf('=') + 1;
    const changed = cookie.slice(0, valueOffset) + (cookie[valueOffset] === 'A' ? 'B' : 'A') + cookie.slice(valueOffset + 1);
    expect((await app.request(`${ORIGIN}/api/account/profile`, { headers: { cookie: changed } })).status).toBe(401);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 9 * 3600_000);
    expect((await app.request(`${ORIGIN}/api/account/profile`, { headers: { cookie } })).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reuses checkout proof across an upstream timeout without accepting browser-supplied proof', async () => {
    const { fetcher, post } = harness();
    fetcher.mockResolvedValueOnce(json(TERMS)).mockRejectedValueOnce(new Error('timeout'));
    const response = await post('premium/start', { orderId: 'forged', claimSecret: 'forged', email: 'buyer@example.com' });
    expect(response.status).toBe(503);
    const proof = bodyOf(fetcher.mock.calls[1]!);
    expect(proof.orderId).toMatch(/^[a-f0-9]{48}$/);
    expect(proof.claimSecret).toMatch(/^[a-f0-9]{64}$/);
    fetcher.mockResolvedValueOnce(json(TERMS)).mockResolvedValueOnce(json({ url: 'https://checkout.stripe.com/c/pay/test' }));
    expect((await post('premium/start', { email: 'buyer@example.com' }, cookieFrom(response))).status).toBe(200);
    expect(bodyOf(fetcher.mock.calls[3]!)).toEqual(proof);
  });
  it('requires a valid checkout cookie to claim credentials', async () => {
    const { fetcher, post } = harness();
    expect((await post('premium/claim', { sessionId: 'cs_stolen' })).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a checkout URL outside Stripe', async () => {
    const { fetcher, post } = harness();
    fetcher.mockResolvedValueOnce(json(TERMS)).mockResolvedValueOnce(json({ url: 'https://checkout.stripe.com.evil.example/pay' }));
    const response = await post('premium/start');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('evil.example');
  });
});
