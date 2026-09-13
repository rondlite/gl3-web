<script setup>
import { ref } from 'vue'
import { installCommands } from './store-api'
defineProps({ username: String, token: String })
const copied = ref(false)
const error = ref('')
async function copy(token) {
  try { await navigator.clipboard.writeText(token); copied.value = true; error.value = '' }
  catch { error.value = 'Select the token and copy it manually.' }
}
</script>
<template>
  <div class="gl3-token-display">
    <p>Save these credentials somewhere private. Use your token as the password when npm asks you to sign in.</p>
    <label>Username<input :value="username" readonly autocomplete="off" /></label>
    <label>npm token<input :value="token" readonly autocomplete="off" spellcheck="false" /></label>
    <button class="gl3-button secondary" type="button" @click="copy(token)">{{ copied ? 'Token copied' : 'Copy token' }}</button>
    <p v-if="error" role="status">{{ error }}</p>
    <pre class="gl3-install"><code>{{ installCommands }}</code></pre>
  </div>
</template>
