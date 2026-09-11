import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const docs = path.join(root, 'docs');
export const dist = path.join(docs, '.vitepress/dist');
export const hash = value => createHash('sha256').update(value).digest('hex');

export function siteBase() {
  const base = process.env.VITEPRESS_BASE || '/orm/';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error(`Invalid VITEPRESS_BASE: ${base}`);
  return base;
}

export async function files(directory, { hidden = false } = {}) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!hidden && entry.name.startsWith('.')) continue;
    const name = path.join(directory, entry.name);
    result.push(...(entry.isDirectory() ? await files(name, { hidden }) : [name]));
  }
  return result.sort();
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.xml': 'application/xml', '.txt': 'text/plain',
};

// Serves real files only: deep routes must exist as HTML, without an SPA fallback.
export async function serve(directory, base = '/') {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (!pathname.startsWith(base)) throw new Error('outside base');
      const relative = pathname.slice(base.length);
      let file = path.resolve(directory, relative || 'index.html');
      if (!file.startsWith(path.resolve(directory) + path.sep)) throw new Error('outside root');
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  };
}
