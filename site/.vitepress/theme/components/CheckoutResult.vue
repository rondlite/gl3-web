<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { storeRequest } from './store-api'
import TokenDisplay from './TokenDisplay.vue'
const state = ref('loading')
const result = ref(null)
const credentials = ref(null)
const error = ref('')
const busy = ref(false)
let timer
let stopped = false
let polls = 0
async function check() {
  error.value = ''
  try {
    const response = await storeRequest('premium/status', {})
    if (stopped) return
    result.value = response
    state.value = response.state
    if (response.state === 'pending' && ++polls < 20) timer = setTimeout(check, 3000)
  } catch (err) {
    if (stopped) return
    state.value = err.status === 404 ? 'missing' : 'error'
    error.value = 'We couldn’t check your purchase yet. Try again; you don’t need to pay again.'
  }
}
async function claim() {
  busy.value = true
  error.value = ''
  try { credentials.value = await storeRequest('premium/claim', {}); result.value.canClaim = false }
  catch (err) {
    error.value = err.status === 410
      ? 'Your credentials have already been shown. Check your purchase email or sign in with your saved token.'
      : 'We couldn’t show your credentials. Check your purchase email or try again.'
  } finally { busy.value = false }
}
onMounted(check)
onUnmounted(() => { stopped = true; clearTimeout(timer) })
</script>

<template>
  <section class="gl3-purchase" aria-label="Purchase status">
    <p v-if="state === 'loading'" role="status">Checking your purchase…</p>
    <template v-else-if="state === 'ready'">
      <span class="gl3-tag is-paid">Premium unlocked</span>
      <h2>Welcome to GL3 Premium.</h2>
      <p>Your payment unlocks premium plugins, updates and support for the paid year.</p>
      <p v-if="result.paidUntil">Paid through {{ new Date(result.paidUntil).toLocaleDateString() }}. <a href="/account.html">Manage your subscription</a>.</p>
      <p><a href="https://discord.gg/6U8ezKE8T">Premium support on Discord</a></p>
      <TokenDisplay v-if="credentials" :username="credentials.username" :token="credentials.token" />
      <template v-else-if="result.canClaim">
        <p>Your npm credentials can be shown here once. Save them before leaving this page.</p>
        <button class="gl3-button" type="button" :disabled="busy" @click="claim">{{ busy ? 'Loading credentials…' : 'Show my credentials' }}</button>
      </template>
      <p v-else>Use your existing or saved npm credentials. If this is your first purchase, your purchase email contains your token.</p>
      <p class="gl3-small" role="status">{{ result.emailSent ? 'Your purchase email has been sent. Check your inbox and spam folder.' : 'Your purchase email is queued for delivery.' }}</p>
      <p><a href="/plugins.html">Explore your plugins</a> · <a href="/account.html">Your account</a></p>
    </template>
    <template v-else-if="state === 'pending'">
      <h2>Confirming your payment</h2>
      <p>Your purchase is still processing. This page checks automatically for about a minute. Your credentials will also arrive by email.</p>
      <button class="gl3-button secondary" type="button" @click="check">Check again</button>
    </template>
    <template v-else-if="state === 'missing'">
      <h2>Check your purchase email</h2>
      <p>Open this page in the browser you used for checkout to see your purchase. Your credentials are also sent to the email address entered at checkout.</p>
      <a href="/account.html">Sign in to your account</a>
    </template>
    <template v-else-if="state === 'expired'">
      <h2>This checkout has expired</h2>
      <p><a href="/pricing.html">Return to Premium</a> to start a new checkout.</p>
    </template>
    <template v-else-if="state === 'refunded'">
      <h2>This purchase was refunded</h2>
      <p>Premium access from this purchase has ended.</p>
    </template>
    <button v-else-if="state === 'error'" class="gl3-button secondary" type="button" @click="check">Check again</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
