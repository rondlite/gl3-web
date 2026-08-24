import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Plugin, PluginDetail } from './catalog.js';

/**
 * Renders a plugin's page as a standalone HTML document.
 *
 * Deliberately not a VitePress page. VitePress hydrates with Vue, and Vue
 * replaces server rendered DOM that does not match what it expects, so
 * injecting a readme into a built page would be a fight over the same nodes.
 * This document links the built stylesheet and uses VitePress's own custom
 * properties instead, so it matches the palette without running the app.
 *
 * The visible cost is that these pages have no nav bar, search box or theme
 * toggle. The alternative, rendering the whole section in the browser, gives
 * up the prerendering these pages exist for.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Finds the built stylesheet, whose filename is content hashed per build.
 *
 * Returns an empty list rather than throwing when the build output is
 * missing or shaped differently: the page then falls back to its own base
 * styles, so a restructured build degrades the appearance rather than the
 * page.
 */
export async function discoverStylesheets(siteDist: string): Promise<string[]> {
  try {
    const html = await readFile(join(siteDist, 'index.html'), 'utf-8');
    // A global regex, required by matchAll, which otherwise throws.
    const matches = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)];
    return matches
      .map((match) => match[1])
      .filter((href): href is string => href !== undefined);
  } catch {
    return [];
  }
}

// Enough to be readable on its own. Only reached when the built stylesheet
// could not be found, so it is a fallback rather than the design.
const FALLBACK_STYLES = `
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 46rem; padding: 2rem 1rem;
         font: 16px/1.6 system-ui, sans-serif; }
  pre { overflow-x: auto; padding: 1rem; background: rgba(127,127,127,.12); }
  img { max-width: 100%; }
`;

// Applies the theme the rest of the site stored, so a visitor in dark mode
// does not hit a white page. The key is VitePress's own.
const THEME_SCRIPT = `
try {
  var pref = localStorage.getItem('vitepress-theme-appearance');
  if (pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch (e) {}
`;

export function renderPluginPage(input: {
  plugin: PluginDetail;
  stylesheets: string[];
  origin: string;
}): string {
  const { plugin, stylesheets, origin } = input;

  const title = escapeHtml(plugin.name);
  const description = escapeHtml(plugin.description ?? `${plugin.name} for GL3`);
  const canonical = escapeHtml(`${origin}${plugin.href}`);
  const tier = plugin.paid ? 'Premium' : 'Free';

  const links =
    stylesheets.length > 0
      ? stylesheets.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('')
      : `<style>${FALLBACK_STYLES}</style>`;

  const readme = plugin.readmeHtml ?? '<p>No description has been published for this plugin yet.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | GL3 plugins</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
${links}
<script>${THEME_SCRIPT}</script>
</head>
<body class="gl3-plugin-page">
<header class="gl3-plugin-page-header">
  <a href="/">GL3</a>
  <a href="/plugins.html">Plugins</a>
</header>
<main>
  <h1>${title}</h1>
  <p class="gl3-plugin-page-meta">
    <span>${tier}</span>
    <span>v${escapeHtml(plugin.version)}</span>
    ${plugin.license === null ? '' : `<span>${escapeHtml(plugin.license)}</span>`}
  </p>
  <pre><code>${escapeHtml(plugin.install)}</code></pre>
  <article>${readme}</article>
</main>
<footer>
  <p>Documentation at <a href="https://docs.gl3.dev">docs.gl3.dev</a>.</p>
</footer>
</body>
</html>`;
}

// The site's built pages. Hard coded rather than read from the build output:
// the list is four entries that change when someone adds a page, and
// walking the dist directory would also pick up assets and the 404.
const STATIC_PATHS = ['/', '/plugins.html', '/pricing.html', '/get-started.html'];

/**
 * Lists every page for crawlers.
 *
 * Load bearing rather than decorative: the plugin grid is rendered in the
 * browser, so a crawler following links would never reach a plugin page.
 * This is the only path by which they are discoverable.
 */
export function renderSitemap(input: { plugins: Plugin[]; origin: string }): string {
  const paths = [...STATIC_PATHS, ...input.plugins.map((plugin) => plugin.href)];
  const urls = paths
    .map((path) => `  <url><loc>${escapeHtml(`${input.origin}${path}`)}</loc></url>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}
