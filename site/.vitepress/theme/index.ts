import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';

import HomeProof from './components/HomeProof.vue';
import PluginGrid from './components/PluginGrid.vue';
import PremiumPurchase from './components/PremiumPurchase.vue';
import CheckoutResult from './components/CheckoutResult.vue';
import AccountPanel from './components/AccountPanel.vue';
import './custom.css';

const theme: Theme = {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-after': () => h(HomeProof),
    }),
  enhanceApp({ app }) {
    app.component('PluginGrid', PluginGrid);
    app.component('PremiumPurchase', PremiumPurchase);
    app.component('CheckoutResult', CheckoutResult);
    app.component('AccountPanel', AccountPanel);
  },
};

export default theme;
