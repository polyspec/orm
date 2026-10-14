import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const docs = path.join(root, 'docs');
export const dist = path.join(docs, '.vitepress/dist');
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function siteBase(): string {
  const base = process.env.VITEPRESS_BASE || '/orm/';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error(`Invalid VITEPRESS_BASE: ${base}`);
  return base;
}

export async function files(directory: string, { hidden = false }: { hidden?: boolean } = {}): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!hidden && entry.name.startsWith('.')) continue;
    const name = path.join(directory, entry.name);
    result.push(...(entry.isDirectory() ? await files(name, { hidden }) : [name]));
  }
  return result.sort();
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.xml': 'application/xml', '.txt': 'text/plain',
};

// Serves real files only: deep routes must exist as HTML, without an SPA fallback.
// requests records every request with the times it was received and answered, so a
// page that does not load can tell a request the server never got from one it answered.
/** A request the docs server received, with the times it was received and answered. */
export type ServedRequest = { url: string | undefined; received: number; answered: number | null; status: number | null };

export async function serve(directory: string, base = '/'): Promise<{ origin: string; requests: ServedRequest[]; close: () => Promise<void> }> {
  const requests: ServedRequest[] = [];
  const server = createServer(async (req, res) => {
    const entry: ServedRequest = { url: req.url, received: Date.now(), answered: null, status: null };
    requests.push(entry);
    res.on('finish', () => { entry.answered = Date.now(); entry.status = res.statusCode; });
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error(`the docs server listens on ${String(address)}, not a TCP port`);
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  };
}
