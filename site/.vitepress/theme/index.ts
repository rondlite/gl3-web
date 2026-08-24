import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';

import PluginGrid from './components/PluginGrid.vue';
import './custom.css';

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('PluginGrid', PluginGrid);
  },
};

export default theme;
