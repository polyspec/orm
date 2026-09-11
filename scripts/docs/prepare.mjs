import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { chromium } from 'playwright';
import { root, docs, files, hash, serve, siteBase } from './lib.mjs';

const parser = new MarkdownIt();
const diagrams = new Map();
for (const file of (await files(docs)).filter(file => file.endsWith('.md'))) {
  for (const token of parser.parse(await readFile(file, 'utf8'), {})) {
    if (token.type !== 'fence' || token.info.trim() !== 'mermaid') continue;
    const id = `diagram-${hash(token.content).slice(0, 24)}`;
    diagrams.set(id, { source: token.content, file: path.relative(root, file), line: token.map[0] + 1 });
  }
}

const output = path.join(docs, 'public/diagrams');
const generated = path.join(docs, '.vitepress/generated');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(generated, { recursive: true });
const server = await serve(root);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto(`${server.origin}/README.md`);
  await page.evaluate(async origin => {
    document.body.replaceChildren();
    const { default: mermaid } = await import(`${origin}/node_modules/mermaid/dist/mermaid.esm.min.mjs`);
    window.renderDiagram = async (id, source) => {
      mermaid.initialize({
        startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
        deterministicIds: true, deterministicIDSeed: id,
        handDrawnSeed: parseInt(id.slice(8, 16), 16) || 1,
        theme: 'neutral', fontFamily: 'Arial, sans-serif', htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: false },
        sequence: { useMaxWidth: false }, class: { useMaxWidth: false },
      });
      await document.fonts.ready;
      const markup = (await mermaid.render(id, source)).svg;
      const svgDocument = new DOMParser().parseFromString(markup, 'image/svg+xml');
      const svg = svgDocument.documentElement;
      const [, , width, height] = svg.getAttribute('viewBox').split(/[ ,]+/).map(Number);
      if (!(width > 0 && height > 0)) throw new Error('invalid SVG dimensions');
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      svg.style.removeProperty('max-width');
      return new XMLSerializer().serializeToString(svg);
    };
  }, server.origin);
  for (const [id, { source, file, line }] of diagrams) {
    try {
      const svg = await page.evaluate(({ id, source }) => window.renderDiagram(id, source), { id, source });
      if (!svg.includes('<svg') || !svg.includes('viewBox=')) throw new Error('missing SVG viewBox');
      await writeFile(path.join(output, `${id}.svg`), svg + '\n');
    } catch (error) {
      throw new Error(`${file}:${line}: ${error.message}`, { cause: error });
    }
  }
  await writeFile(path.join(generated, 'diagrams.json'), JSON.stringify([...diagrams.keys()], null, 2) + '\n');
  await writeFile(path.join(generated, 'site.json'), JSON.stringify({ base: siteBase() }) + '\n');
  console.log(`docs: ${diagrams.size} Mermaid diagrams rendered to static SVG`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
