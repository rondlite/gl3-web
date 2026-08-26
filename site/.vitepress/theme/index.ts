import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';

import HomeProof from './components/HomeProof.vue';
import PluginGrid from './components/PluginGrid.vue';
import './custom.css';

const theme: Theme = {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-after': () => h(HomeProof),
    }),
  enhanceApp({ app }) {
    app.component('PluginGrid', PluginGrid);
  },
};

export default theme;
