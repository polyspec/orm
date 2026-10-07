import { defineConfig } from 'vitepress';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const base = process.env.VITEPRESS_BASE || '/orm/';
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('Invalid VITEPRESS_BASE');
const root = process.cwd();
const docs = path.join(root, 'docs');
const repo = 'https://github.com/polyspec/orm';

export default defineConfig({
  title: 'orm',
  description: 'Schema-based ORM with a common API and data model for Go, PHP, Rust, and TypeScript.',
  lang: 'en-US',
  base,
  cleanUrls: false,
  // Korean pages are published under /ko/.
  rewrites: id => id.endsWith('.ko.md') ? `ko/${id.slice(0, -'.ko.md'.length)}.md` : id,
  // Stable insertion order keeps the local search index reproducible.
  buildConcurrency: 1,
  lastUpdated: false,
  sitemap: { hostname: `https://polyspec.github.io${base}` },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
  ],
  // VitePress leaves the 404 page shell empty; preserve the rendered document for no-JS readers.
  transformHtml(html, _file, { page, content }) {
    const korean = page.startsWith('ko/') || page.endsWith('.ko.md');
    const stem = page.startsWith('ko/') ? page.slice('ko/'.length).replace(/\.md$/, '') : (korean ? page.slice(0, -'.ko.md'.length) : page.replace(/\.md$/, ''));
    const pair = korean ? stem : `ko/${stem}`;
    const link = `${base}${pair}.html`;
    const sourcePair = korean ? path.join(docs, `${stem}.md`) : path.join(docs, `${stem}.ko.md`);
    const switcher = existsSync(sourcePair) ? `<nav class="orm-language-switch"><a href="${link}">${korean ? 'English' : '한국어'}</a></nav>` : '';
    const body = html.replace('<div id="app"></div>', `${switcher}<div id="app"></div>`);
    return page === '404.md' ? body.replace('<div id="app"></div>', `<div id="app"></div><noscript>${content}</noscript>`) : body;
  },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'orm',
    nav: [
      { text: 'Guide', link: '/usage' },
      { text: 'Common API', link: '/interfaces' },
      { text: 'Implementation', link: '/interface-implementation' },
      { text: '한국어', link: '/ko/' },
    ],
    sidebar: [
      { text: 'Start', items: [
        { text: 'Overview', link: '/' },
        { text: 'Guide', link: '/usage' },
        { text: 'Schema', link: '/schema' },
        { text: 'Configuration', link: '/config' },
        { text: 'Complex query example', link: '/examples/complex-query' },
      ] },
      { text: 'Common specification', items: [
        { text: 'Design plan', link: '/plan' },
        { text: 'Structure and public API', link: '/interfaces' },
        { text: 'Component diagram', link: '/interfaces-model' },
        { text: 'DSL', link: '/dsl' },
        { text: 'IR and Plan protocol', link: '/protocol' },
        { text: 'Codecs', link: '/codec' },
        { text: 'dbspec schema language', link: '/dbspec' },
        { text: 'Database dialects', link: '/dialects' },
        { text: 'Schema plans', link: '/plans' },
        { text: 'Mermaid diagrams', link: '/mermaid' },
      ] },
      { text: 'Development and verification', items: [
        { text: 'Implementation matrix', link: '/interface-implementation' },
        { text: 'Checklist', link: '/checklist' },
        { text: 'Performance', link: '/perf' },
        { text: 'Packaging', link: '/packaging' },
        { text: 'Documentation build and deployment', link: '/docs-development' },
      ] },
    ],
    outline: { level: [2, 3], label: 'On this page' },
    docFooter: { prev: 'Previous page', next: 'Next page' },
    sidebarMenuLabel: 'Menu',
    returnToTopLabel: 'Return to top',
    darkModeSwitchLabel: 'Theme',
    lightModeSwitchTitle: 'Switch to light theme',
    darkModeSwitchTitle: 'Switch to dark theme',
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'GitHub에서 수정' },
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local', options: { locales: { root: { translations: {
      button: { buttonText: '검색', buttonAriaLabel: '문서 검색' },
      modal: { displayDetails: '상세 내용 표시', resetButtonTitle: '검색 초기화',
        backButtonTitle: '검색 닫기', noResultsText: '검색 결과가 없어요.',
        footer: { selectText: '선택', navigateText: '이동', closeText: '닫기' } },
    } } } } },
    footer: { message: 'MIT License · Go / PHP / Rust / TypeScript', copyright: 'polyspec · orm' },
  },
  markdown: {
    config(md) {
      // Vue compiles each page as a template, so `{{` in Markdown text or code would run as an
      // interpolation. VitePress marks fenced code v-pre; inline code, indented code and text that
      // holds `{{` are marked here, so Markdown always shows `{{` as written.
      for (const rule of ['code_inline', 'code_block'] as const) {
        const render = md.renderer.rules[rule]!;
        md.renderer.rules[rule] = (tokens, index, options, env, self) => {
          tokens[index].attrSet('v-pre', '');
          return render(tokens, index, options, env, self);
        };
      }
      const text = md.renderer.rules.text!;
      md.renderer.rules.text = (tokens, index, options, env, self) => {
        const html = text(tokens, index, options, env, self);
        return html.includes('{{') ? `<span v-pre>${html}</span>` : html;
      };
      // Source links stay valid in GitHub Markdown and in the static site.
      md.core.ruler.after('inline', 'repository-links', state => {
        const visit = tokens => {
          for (const token of tokens) {
            if (token.children) visit(token.children);
            if (token.type !== 'link_open') continue;
            const href = token.attrGet('href');
            if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
            const [name, suffix = ''] = href.split(/(?=[?#])/s, 2);
            const koreanPage = state.env.relativePath.startsWith('ko/') || state.env.path.endsWith('.ko.md');
            // Rewritten Korean pages resolve relative links from their .ko.md source directory.
            const sourcePath = state.env.relativePath.startsWith('ko/')
              ? path.join(docs, state.env.relativePath.slice('ko/'.length).replace(/\.md$/, '.ko.md'))
              : state.env.path;
            let target = path.resolve(href.startsWith('/') ? docs : path.dirname(sourcePath), '.' + (href.startsWith('/') ? name : '/' + name));
            if (koreanPage && !existsSync(target)) target = path.resolve(docs, name);
            if (!koreanPage && target.startsWith(docs + path.sep) && target.endsWith('.ko.md')) {
              const relative = path.relative(docs, target).split(path.sep).map(encodeURIComponent).join('/');
              token.attrSet('href', `/ko/${relative.slice(0, -'.ko.md'.length)}.html${suffix}`);
              continue;
            }
            if (koreanPage && target.startsWith(docs + path.sep) && target.endsWith('.ko.md')) {
              const relative = path.relative(docs, target).split(path.sep).map(encodeURIComponent).join('/');
              token.attrSet('href', `/ko/${relative.slice(0, -'.ko.md'.length)}.html${suffix}`);
              continue;
            }
            if (koreanPage && target.startsWith(docs + path.sep) && target.endsWith('.md')) {
              const relative = path.relative(docs, target).split(path.sep).map(encodeURIComponent).join('/');
              token.attrSet('href', `../${relative.replace(/\.md$/, '.html')}${suffix}`);
              continue;
            }
            if (target.startsWith(docs + path.sep) && (target.endsWith('.md') || !path.extname(target))) continue;
            if (!target.startsWith(root + path.sep) || !existsSync(target)) throw new Error(`${state.env.relativePath}: missing source link ${href}`);
            const kind = statSync(target).isDirectory() ? 'tree' : 'blob';
            const relative = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/');
            token.attrSet('href', `${repo}/${kind}/main/${relative}${suffix}`);
          }
        };
        visit(state.tokens);
      });
      // A Mermaid fence stays its source: the theme renders it in the reader's browser
      // (theme/index.ts), and without JavaScript the source is shown.
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token.info.trim() !== 'mermaid') return fence(tokens, index, options, env, self);
        return `<pre class="mermaid" v-pre>${md.utils.escapeHtml(token.content)}</pre>`;
      };
    },
  },
});
