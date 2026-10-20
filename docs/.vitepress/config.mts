import { defineConfig, type UserConfig } from 'vitepress';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { dbsFences, dbsInfo, renderDbs } from './dbs';
import { englishHref } from './links.ts';

/** The markdown-it instance that VitePress gives markdown.config, and the token of its token streams. */
type Markdown = Parameters<NonNullable<NonNullable<UserConfig['markdown']>['config']>>[0];
type Token = Parameters<NonNullable<Markdown['renderer']['rules']['fence']>>[0][number];

/**
 * The page fields of the env that VitePress gives markdown-it: markdown-it types env as any, so each field is checked.
 */
function pageEnv(env: unknown): { relativePath: string; path: string } {
  if (typeof env !== 'object' || env === null) throw new Error('markdown-it env is not the page env of VitePress');
  const relativePath: unknown = Reflect.get(env, 'relativePath');
  const path: unknown = Reflect.get(env, 'path');
  if (typeof relativePath !== 'string' || typeof path !== 'string') {
    throw new Error('markdown-it env names no relativePath and path strings of VitePress');
  }
  return { relativePath, path };
}

/** The renderer rule `name` that markdown-it defines, which a wrapper calls. */
function rule(md: Markdown, name: string): NonNullable<Markdown['renderer']['rules'][string]> {
  const found = md.renderer.rules[name];
  if (found === undefined) throw new Error(`markdown-it defines no renderer rule ${name}`);
  return found;
}

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
      { text: 'Guide', link: '/operations/usage' },
      { text: 'Common API', link: '/spec/interfaces' },
      { text: 'Implementation', link: '/spec/interface-implementation' },
      { text: '한국어', link: '/ko/' },
    ],
    sidebar: [
      { text: 'Start', items: [
        { text: 'Overview', link: '/' },
        { text: 'Guide', link: '/operations/usage' },
        { text: 'Schema', link: '/spec/schema' },
        { text: 'Configuration', link: '/spec/config' },
        { text: 'Complex query example', link: '/spec/complex-query' },
      ] },
      { text: 'Common specification', items: [
        { text: 'Design plan', link: '/spec/plan' },
        { text: 'Structure and public API', link: '/spec/interfaces' },
        { text: 'Component diagram', link: '/spec/interfaces-model' },
        { text: 'DSL', link: '/spec/dsl' },
        { text: 'IR and Plan protocol', link: '/spec/protocol' },
        { text: 'Codecs', link: '/spec/codec' },
        { text: 'dbspec schema language', link: '/spec/dbspec' },
        { text: 'dbspec editor tools', link: '/spec/editor' },
        { text: 'Database dialects', link: '/spec/dialects' },
        { text: 'Schema plans', link: '/spec/plans' },
        { text: 'Mermaid diagrams', link: '/spec/mermaid' },
      ] },
      { text: 'Development and verification', items: [
        { text: 'Implementation matrix', link: '/spec/interface-implementation' },
        { text: 'Checklist', link: '/plans/execution/checklist' },
        { text: 'Performance', link: '/operations/perf' },
        { text: 'Packaging', link: '/operations/packaging' },
        { text: 'Documentation build and deployment', link: '/operations/docs-development' },
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
      for (const name of ['code_inline', 'code_block']) {
        const render = rule(md, name);
        md.renderer.rules[name] = (tokens, index, options, env, self) => {
          tokens[index]?.attrSet('v-pre', '');
          return render(tokens, index, options, env, self);
        };
      }
      const text = rule(md, 'text');
      md.renderer.rules.text = (tokens, index, options, env, self) => {
        const html = text(tokens, index, options, env, self);
        return html.includes('{{') ? `<span v-pre>${html}</span>` : html;
      };
      // Source links stay valid in GitHub Markdown and in the static site.
      md.core.ruler.after('inline', 'repository-links', state => {
        const visit = (tokens: readonly Token[]): void => {
          for (const token of tokens) {
            if (token.children) visit(token.children);
            if (token.type !== 'link_open') continue;
            const href = token.attrGet('href');
            if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
            // A link of a page reads the page fields of env; markdown-it also parses inline text (a title) without them.
            const page = pageEnv(state.env);
            const [name = href, suffix = ''] = href.split(/(?=[?#])/s, 2);
            const koreanPage = page.relativePath.startsWith('ko/') || page.path.endsWith('.ko.md');
            // Rewritten Korean pages resolve relative links from their .ko.md source directory.
            const sourcePath = page.relativePath.startsWith('ko/')
              ? path.join(docs, page.relativePath.slice('ko/'.length).replace(/\.md$/, '.ko.md'))
              : page.path;
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
              token.attrSet('href', englishHref(docs, target, suffix));
              continue;
            }
            if (target.startsWith(docs + path.sep) && (target.endsWith('.md') || !path.extname(target))) continue;
            if (!target.startsWith(root + path.sep) || !existsSync(target)) throw new Error(`${page.relativePath}: missing source link ${href}`);
            const kind = statSync(target).isDirectory() ? 'tree' : 'blob';
            const relative = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/');
            token.attrSet('href', `${repo}/${kind}/main/${relative}${suffix}`);
          }
        };
        visit(state.tokens);
      });
      // A Mermaid fence stays its source: the theme renders it in the reader's browser
      // (theme/index.ts), and without JavaScript the source is shown.
      const fence = rule(md, 'fence');
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token === undefined) throw new Error(`markdown-it renders a fence at ${index} past its ${tokens.length} tokens`);
        // A dbs fence is rendered from the language service's tokens (dbs.ts); a diagnostic fails the build.
        if (dbsInfo(token.info) !== null) {
          const fences = dbsFences(tokens);
          const line = token.map === null ? null : token.map[0] + 1;
          const own = fences.find(f => f.text === token.content && f.line === line);
          if (own === undefined) throw new Error(`${pageEnv(env).relativePath}: a dbs fence is missing from the fences of its page`);
          return renderDbs(own, fences, pageEnv(env).relativePath, md.utils.escapeHtml);
        }
        if (token.info.trim() !== 'mermaid') return fence(tokens, index, options, env, self);
        return `<pre class="mermaid" v-pre>${md.utils.escapeHtml(token.content)}</pre>`;
      };
    },
  },
});
