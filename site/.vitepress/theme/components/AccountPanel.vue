<script setup>
import { onMounted, ref } from 'vue'
import { storeRequest, installCommands } from './store-api'
import TokenDisplay from './TokenDisplay.vue'
const loading = ref(true)
const busy = ref(false)
const profile = ref(null)
const username = ref('')
const token = ref('')
const error = ref('')
const replacement = ref(null)
const confirmRotation = ref(false)
const billing = ref(null)
const date = value => new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
async function loadBilling() {
  try { billing.value = await storeRequest('account/billing') }
  catch { error.value = 'Subscription details are temporarily unavailable. Please try again.' }
}
async function manage() {
  busy.value = true
  try { window.location.assign((await storeRequest('account/portal', {})).url) }
  catch { error.value = 'We couldn’t open subscription management. Please try again.'; busy.value = false }
}
async function load() {
  loading.value = true
  try { profile.value = await storeRequest('account/profile'); await loadBilling() }
  catch (err) { if (err.status !== 401) error.value = 'Your account is temporarily unavailable. Please try again.' }
  finally { loading.value = false }
}
async function login() {
  busy.value = true
  error.value = ''
  try { profile.value = await storeRequest('account/login', { username: username.value, token: token.value }); token.value = ''; await loadBilling() }
  catch (err) { error.value = err.status === 401 ? 'Check your username and npm token, then try again.' : 'Sign-in is temporarily unavailable. Please try again.' }
  finally { busy.value = false }
}
async function logout() {
  busy.value = true
  try { await storeRequest('account/logout', {}); profile.value = null; replacement.value = null; confirmRotation.value = false; billing.value = null }
  catch { error.value = 'We couldn’t sign you out. Please try again.' }
  finally { busy.value = false }
}
async function rotate() {
  busy.value = true
  error.value = ''
  try { replacement.value = await storeRequest('account/rotate-token', {}); confirmRotation.value = false }
  catch { error.value = 'We couldn’t replace your token. If your current token no longer works, contact us on Discord.' }
  finally { busy.value = false }
}
onMounted(load)
</script>
<template>
  <section class="gl3-purchase" aria-label="Your GL3 account">
    <p v-if="loading" role="status">Loading your account…</p>
    <template v-else-if="profile">
      <h2>{{ profile.username }}</h2>
      <p>{{ profile.premium ? 'Your Premium licence unlocks every @gl3-plugins package.' : 'This account does not have an active Premium licence.' }}</p>
      <template v-if="billing">
        <p v-if="billing.paidUntil">Paid access {{ new Date(billing.paidUntil) > new Date() ? 'through' : 'ended on' }} {{ date(billing.paidUntil) }}.</p>
        <p v-if="billing.subscription?.cancelAtPeriodEnd">Renewal is cancelled. Your access continues through the paid date above.</p>
        <p v-else-if="billing.subscription && ['active', 'past_due', 'unpaid'].includes(billing.subscription.status)">
          {{ billing.subscription.status === 'active' ? 'Annual renewal: €49, VAT included.' : 'Your renewal payment needs attention. Manage your subscription to update payment details.' }}
        </p>
        <button v-if="billing.subscription" class="gl3-button secondary" type="button" :disabled="busy" @click="manage">Manage subscription and payments</button>
        <p v-if="!billing.subscription || ['canceled', 'incomplete_expired'].includes(billing.subscription.status)"><a href="/pricing.html">{{ billing.renewalEligible ? 'Renew for €49' : 'Get Premium' }}</a></p>
      </template>
      <p><a href="https://discord.gg/6U8ezKE8T">Premium support on Discord</a></p>
      <TokenDisplay v-if="replacement" :username="replacement.username" :token="replacement.token" />
      <pre v-else class="gl3-install"><code>{{ installCommands }}</code></pre>
      <template v-if="confirmRotation">
        <p>Replacing your token immediately stops the current token from working. Save the new token and update npm on every machine that uses the old one.</p>
        <div class="gl3-actions">
          <button class="gl3-button" type="button" :disabled="busy" @click="rotate">{{ busy ? 'Replacing…' : 'Replace my token' }}</button>
          <button class="gl3-button secondary" type="button" :disabled="busy" @click="confirmRotation = false">Cancel</button>
        </div>
      </template>
      <div v-else class="gl3-actions">
        <button class="gl3-button secondary" type="button" :disabled="busy" @click="confirmRotation = true">Replace npm token</button>
        <button class="gl3-button secondary" type="button" :disabled="busy" @click="logout">Sign out</button>
      </div>
    </template>
    <form v-else @submit.prevent="login">
      <h2>Sign in with your npm credentials</h2>
      <p>Your username and <code>gl3_</code> token are in your purchase email.</p>
      <label for="gl3-username">Username</label>
      <input id="gl3-username" v-model="username" required maxlength="100" autocomplete="username" autocapitalize="none" spellcheck="false" />
      <label for="gl3-token">npm token</label>
      <input id="gl3-token" v-model="token" required type="password" autocomplete="current-password" spellcheck="false" />
      <button class="gl3-button" type="submit" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
      <p class="gl3-small">Lost your token? Contact us on Discord with your purchase reference. Tokens can’t be recovered from the account page.</p>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
