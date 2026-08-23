import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'GL3',
  description: 'A modern engine for text based gangster games, and the move off Gangster Legends V2.',
  // cleanUrls stays off so pages are served as plain .html files with no server
  // side rewriting. docs.gl3.dev already serves URLs this way.
  cleanUrls: false,
  lastUpdated: false,
  ignoreDeadLinks: 'localhostLinks',
  themeConfig: {
    nav: [
      { text: 'Plugins', link: '/plugins.html' },
      { text: 'Pricing', link: '/pricing.html' },
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
