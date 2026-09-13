<script setup>
import { onMounted, onUnmounted, ref } from 'vue'

const premiumCount = ref(null)
const controller = new AbortController()
let timeout
onUnmounted(() => { controller.abort(); clearTimeout(timeout) })
onMounted(async () => {
  timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch('/api/plugins', { signal: controller.signal })
    if (!response.ok) return
    const body = await response.json()
    if (body.available === true && Array.isArray(body.plugins)) {
      premiumCount.value = new Set(body.plugins
        .filter(plugin => plugin?.paid === true && typeof plugin.name === 'string' && plugin.name.startsWith('@gl3-plugins/'))
        .map(plugin => plugin.name)).size
    }
  } catch {
    // Keep the catalogue link useful when its live count is unavailable.
  } finally { clearTimeout(timeout) }
})
</script>

<template>
  <ul class="gl3-proof">
    <li>
      <strong>27</strong>
      <span>bundled plugins, free with the engine</span>
    </li>
    <li>
      <a href="/plugins.html">
        <strong>{{ premiumCount === null ? 'Explore' : premiumCount }}</strong>
        <span>additional Premium plugins</span>
      </a>
    </li>
    <li>
      <strong>4</strong>
      <span>game profiles to start from</span>
    </li>
    <li>
      <strong>MIT</strong>
      <span>open-source engine, yours to host</span>
    </li>
  </ul>
</template>
