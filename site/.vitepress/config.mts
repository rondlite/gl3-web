import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'GL3',
  description:
    'A platform for persistent browser games. The default boot is a complete gangster game, and the framework profile is the engine on its own.',
  // cleanUrls stays off so pages are served as plain .html files with no server
  // side rewriting. docs.gl3.dev already serves URLs this way.
  cleanUrls: false,
  lastUpdated: false,
  ignoreDeadLinks: 'localhostLinks',
  // The logo is a dark lockup, so the icons ship as the blue 3 on its own: it
  // is the only part of the mark that stays legible at 16px.
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: '48x48' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'GL3' }],
    ['meta', { property: 'og:image', content: 'https://gl3.dev/og.jpg' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://gl3.dev/og.jpg' }],
  ],
  themeConfig: {
    // The wordmark already reads GL3, so the text title beside it would repeat.
    logo: { src: '/gl3-wordmark.webp', alt: 'GL3' },
    siteTitle: false,
    nav: [
      { text: 'Plugins', link: '/plugins.html' },
      { text: 'Premium', link: '/pricing.html' },
      { text: 'Get started', link: '/get-started.html' },
      { text: 'Docs', link: 'https://docs.gl3.dev' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/rondlite/GL3' }],
    footer: {
      message: 'Documentation at docs.gl3.dev. Live demo at game.gl3.dev.',
      copyright: 'GL3',
    },
  },
});
