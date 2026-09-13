<script setup>
import { onMounted, ref } from 'vue'
import { storeRequest } from './store-api'

const checkoutReady = ref(false)
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const cancelled = ref(false)
const email = ref('')
const signedIn = ref(false)
const returning = ref(false)
const hasSubscription = ref(false)
async function load() {
  loading.value = true
  error.value = ''
  try {
    const terms = await storeRequest('premium/price')
    checkoutReady.value = terms.billing === 'annual' && terms.firstYearAmount === 6900 &&
      terms.renewalAmount === 4900 && terms.currency === 'eur' && terms.vatIncluded === true
    if (!checkoutReady.value) throw new Error('billing_not_ready')
    try {
      await storeRequest('account/profile')
      signedIn.value = true
      const billing = await storeRequest('account/billing')
      returning.value = billing.renewalEligible
      hasSubscription.value = billing.subscription && !['canceled', 'incomplete_expired'].includes(billing.subscription.status)
    } catch (err) { if (err.status !== 401) { checkoutReady.value = false; throw err } }
  }
  catch { error.value = 'Purchasing is temporarily unavailable. Please try again shortly.' }
  finally { loading.value = false }
}
async function purchase() {
  if (busy.value || !checkoutReady.value) return
  busy.value = true
  error.value = ''
  try {
    const checkout = await storeRequest('premium/start', signedIn.value ? {} : { email: email.value })
    window.location.assign(checkout.completed ? '/checkout.html' : checkout.url)
  } catch (err) {
    const messages = {
      checkout_expired: 'Your previous checkout expired. Please start a new checkout.',
      sign_in_required: 'This email belongs to an existing account. Sign in with your npm credentials to continue.',
      subscription_exists: 'You already have a subscription. Manage it from your account.',
      checkout_in_progress: 'There is already a checkout in progress for this account. Continue in the browser where you started it.',
    }
    error.value = messages[err.message] || 'We couldn’t open checkout. Please try again.'
    busy.value = false
  }
}
onMounted(() => { cancelled.value = new URLSearchParams(window.location.search).has('cancelled'); load() })
</script>

<template>
  <section class="gl3-purchase" aria-label="Buy GL3 Premium" :aria-busy="loading || busy">
    <span class="gl3-tag is-paid">GL3 Premium</span>
    <h2>Every plugin. Every game you build.</h2>
    <p>All premium plugins, updates and support. One personal subscription for any number of your own games.</p>
    <p class="gl3-price">{{ returning ? '€49' : '€69' }} <span>{{ returning ? 'for another year' : 'for your first year' }}</span></p>
    <p class="gl3-renewal">Then <strong>€49 / year</strong>. Both prices include VAT.</p>
    <p class="gl3-small">Cancel before renewal. Keep your €49 renewal rate, even if you take a break.</p>
    <ul class="gl3-purchase-benefits">
      <li>All <code>@gl3-plugins</code> packages, including new releases while subscribed</li>
      <li>Any number of your own games</li>
      <li>Installation and upgrade help, plus engine and plugin bug fixes</li>
      <li>No AI service required</li>
    </ul>
    <p v-if="loading" role="status">Checking checkout availability…</p>
    <template v-else-if="checkoutReady">
      <p v-if="cancelled" role="status">Checkout was cancelled. You can continue whenever you’re ready.</p>
      <p v-if="hasSubscription">You already have a subscription. <a href="/account.html">Manage your subscription</a>.</p>
      <form v-else @submit.prevent="purchase">
        <template v-if="!signedIn">
          <label for="premium-email">Your email address</label>
          <input id="premium-email" v-model="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com" />
          <p class="gl3-small">We’ll send your registry credentials here. Returning subscribers: <a href="/account.html">sign in first</a> for your €49 renewal.</p>
        </template>
        <button class="gl3-button" type="submit" :disabled="busy">
          {{ busy ? 'Opening checkout…' : returning ? 'Renew for €49' : 'Subscribe for €69' }}
        </button>
        <p class="gl3-small">{{ returning ? '€49' : '€69' }} today, then €49 each year. VAT included.</p>
      </form>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="!loading && !checkoutReady" class="gl3-button secondary" type="button" @click="load">Try again</button>
    <p class="gl3-small">Already have a licence? <a href="/account.html">Sign in to your account</a>.</p>
  </section>
  <noscript><p>Enable JavaScript to subscribe to Premium.</p></noscript>
</template>
