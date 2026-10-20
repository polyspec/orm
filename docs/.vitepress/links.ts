// The links that the documentation site rewrites (docs/.vitepress/config.mts).
import path from 'node:path';

/**
 * englishHref is the href by which a Korean page links to the English page target, a .md file under docs, with the query or
 * fragment suffix: the published path of the English page.
 */
export function englishHref(docs: string, target: string, suffix: string): string {
  const relative = path.relative(docs, target).split(path.sep).map(encodeURIComponent).join('/');
  // From the site root, so a Korean page at any depth reaches it; a relative path is right only at the top level.
  return `/${relative.replace(/\.md$/, '.html')}${suffix}`;
}
