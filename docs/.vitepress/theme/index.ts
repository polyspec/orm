import type { Theme } from 'vitepress';
import { useRoute } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { nextTick, onMounted, watch } from 'vue';
import './style.css';

// renderMermaid draws the page's Mermaid sources (<pre class="mermaid">, see config.mts) in the
// reader's browser. mermaid is imported on the client only.
async function renderMermaid() {
  await nextTick();
  const nodes = [...document.querySelectorAll<HTMLElement>('.vp-doc pre.mermaid:not([data-processed])')];
  if (!nodes.length) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
  await mermaid.run({ nodes });
}

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // A production Vue build only logs a render error and renders the page without the failed
    // part. During the build's server render the error must stop the build instead.
    if (import.meta.env.SSR) app.config.throwUnhandledErrorInProduction = true;
  },
  setup() {
    const route = useRoute();
    onMounted(renderMermaid);
    watch(() => route.path, renderMermaid);
  },
} satisfies Theme;
