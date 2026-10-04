import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // A production Vue build only logs a render error and renders the page without the failed
    // part. During the build's server render the error must stop the build instead.
    if (import.meta.env.SSR) app.config.throwUnhandledErrorInProduction = true;
  },
} satisfies Theme;
