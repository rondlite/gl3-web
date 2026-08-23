<script setup>
import { onMounted, ref } from 'vue'

// 'loading' until the first response, then 'ready' or 'unavailable'.
const state = ref('loading')
const plugins = ref([])

onMounted(async () => {
  try {
    const response = await fetch('/api/plugins')
    if (!response.ok) {
      state.value = 'unavailable'
      return
    }
    const body = await response.json()
    plugins.value = body.plugins ?? []
    // available:false means the server could not reach store-api and had
    // nothing cached. Say so rather than rendering an empty grid, which would
    // read as "there are no plugins".
    state.value = body.available ? 'ready' : 'unavailable'
  } catch {
    state.value = 'unavailable'
  }
})
</script>

<template>
  <p v-if="state === 'loading'" class="gl3-plugins-note">Loading the catalogue.</p>

  <p v-else-if="state === 'unavailable'" class="gl3-plugins-note">
    The plugin catalogue is not reachable right now. Everything else on this site still
    works, and the list will come back on its own.
  </p>

  <p v-else-if="plugins.length === 0" class="gl3-plugins-note">
    No plugins are published yet.
  </p>

  <div v-else class="gl3-plugins">
    <article v-for="plugin in plugins" :key="plugin.name" class="gl3-plugin">
      <header>
        <h3>{{ plugin.name }}</h3>
        <span :class="['gl3-tag', plugin.paid ? 'is-paid' : 'is-free']">
          {{ plugin.paid ? 'Premium' : 'Free' }}
        </span>
      </header>

      <p v-if="plugin.description">{{ plugin.description }}</p>

      <footer>
        <code>{{ plugin.install }}</code>
        <span class="gl3-version">v{{ plugin.version }}</span>
      </footer>
    </article>
  </div>
</template>
