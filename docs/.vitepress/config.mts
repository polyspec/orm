import { defineConfig } from 'vitepress';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const base = process.env.VITEPRESS_BASE || '/orm/';
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('Invalid VITEPRESS_BASE');
const root = process.cwd();
const docs = path.join(root, 'docs');
const repo = 'https://github.com/polyspec/orm';
const diagrams = new Set<string>(JSON.parse(readFileSync(path.join(docs, '.vitepress/generated/diagrams.json'), 'utf8')));

export default defineConfig({
  title: 'orm',
  description: 'Go · PHP · Rust — 공통 문법과 자료구조를 사용하는 스키마 기반 ORM',
  lang: 'ko-KR',
  base,
  cleanUrls: false,
  // Stable insertion order keeps the local search index reproducible.
  buildConcurrency: 1,
  lastUpdated: false,
  sitemap: { hostname: `https://polyspec.github.io${base}` },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
  ],
  // VitePress leaves the 404 app shell empty; preserve the rendered document for no-JS readers.
  transformHtml(html, _file, { page, content }) {
    return page === '404.md' ? html.replace('<div id="app"></div>', `<div id="app"></div><noscript>${content}</noscript>`) : html;
  },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'orm',
    nav: [
      { text: '사용법', link: '/usage' },
      { text: '공통 인터페이스', link: '/interfaces' },
      { text: '구현 상태', link: '/interface-implementation' },
    ],
    sidebar: [
      { text: '시작하기', items: [
        { text: '소개', link: '/' },
        { text: '사용법', link: '/usage' },
        { text: '스키마', link: '/schema' },
        { text: '설정', link: '/config' },
        { text: '복잡한 쿼리 예제', link: '/examples/complex-query' },
      ] },
      { text: '공통 명세', items: [
        { text: '구조 · 수명 · 공개 API', link: '/interfaces' },
        { text: '구성요소 도표', link: '/interfaces-model' },
        { text: '문법', link: '/dsl' },
        { text: 'IR · Plan 프로토콜', link: '/protocol' },
        { text: '코덱', link: '/codec' },
        { text: '데이터베이스 방언', link: '/dialects' },
      ] },
      { text: '개발과 검증', items: [
        { text: '구현 대조표', link: '/interface-implementation' },
        { text: '체크리스트', link: '/checklist' },
        { text: '성능 측정', link: '/perf' },
        { text: '패키징', link: '/packaging' },
        { text: '문서 빌드와 배포', link: '/docs-development' },
        { text: '이전 설계 기록', link: '/archive' },
      ] },
    ],
    outline: { level: [2, 3], label: '이 문서의 내용' },
    docFooter: { prev: '이전 문서', next: '다음 문서' },
    sidebarMenuLabel: '문서 목록',
    returnToTopLabel: '맨 위로',
    darkModeSwitchLabel: '테마',
    lightModeSwitchTitle: '밝은 테마',
    darkModeSwitchTitle: '어두운 테마',
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'GitHub에서 수정' },
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local', options: { locales: { root: { translations: {
      button: { buttonText: '검색', buttonAriaLabel: '문서 검색' },
      modal: { displayDetails: '상세 내용 표시', resetButtonTitle: '검색 초기화',
        backButtonTitle: '검색 닫기', noResultsText: '검색 결과가 없어요.',
        footer: { selectText: '선택', navigateText: '이동', closeText: '닫기' } },
    } } } } },
    footer: { message: 'MIT License · Go / PHP / Rust', copyright: 'polyspec · orm' },
  },
  markdown: {
    config(md) {
      // Source links stay valid in GitHub Markdown and in the static site.
      md.core.ruler.after('inline', 'repository-links', state => {
        const visit = tokens => {
          for (const token of tokens) {
            if (token.children) visit(token.children);
            if (token.type !== 'link_open') continue;
            const href = token.attrGet('href');
            if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
            const [name, suffix = ''] = href.split(/(?=[?#])/s, 2);
            const target = path.resolve(href.startsWith('/') ? docs : path.dirname(state.env.path), '.' + (href.startsWith('/') ? name : '/' + name));
            if (target.startsWith(docs + path.sep) && (target.endsWith('.md') || !path.extname(target))) continue;
            if (!target.startsWith(root + path.sep) || !existsSync(target)) throw new Error(`${state.env.relativePath}: missing source link ${href}`);
            const kind = statSync(target).isDirectory() ? 'tree' : 'blob';
            const relative = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/');
            token.attrSet('href', `${repo}/${kind}/main/${relative}${suffix}`);
          }
        };
        visit(state.tokens);
      });
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        const token = tokens[index];
        if (token.info.trim() !== 'mermaid') return fence(tokens, index, options, env, self);
        const id = 'diagram-' + createHash('sha256').update(token.content).digest('hex').slice(0, 24);
        if (!diagrams.has(id)) throw new Error(`${env.relativePath}: run the docs build to prepare Mermaid SVGs`);
        const url = `${base}diagrams/${id}.svg`;
        let title = env.relativePath;
        for (let n = index - 1; n >= 0; n--) {
          if (tokens[n].type === 'heading_open') { title = tokens[n + 1].content; break; }
        }
        return `<figure class="orm-diagram"><div class="orm-diagram-viewport" tabindex="0" role="region" aria-label="스크롤 가능한 도표"><img :src="'${url}'" alt="${md.utils.escapeHtml(title)}" loading="lazy"></div><figcaption><a href="${url}" target="_blank" rel="noopener">SVG 원본 보기</a></figcaption><details><summary>Mermaid 소스</summary><pre v-pre><code>${md.utils.escapeHtml(token.content)}</code></pre></details></figure>`;
      };
    },
  },
});
