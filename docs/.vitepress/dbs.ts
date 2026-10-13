// The dbs fence of the docs site: the Go grammar core tokenizes (cmd/orm-tokens over
// engine/dbspec Tokens) and this module renders the spans, so the site highlights exactly the
// grammar the engine parses and never re-states it.
import { spawnSync } from 'node:child_process';
import { env } from 'node:process';

/** One highlighted span of a line, as cmd/orm-tokens prints them. */
interface Token {
  cls: string;
  line: number;
  start: number;
  end: number;
}

/** The binary of the tokenizer, from ORM_TOKENS or next to the checkout's own build. */
const tokens = env.ORM_TOKENS ?? new URL('../../.runtime/bin/orm-tokens', import.meta.url).pathname;

/** Tokenizes one dbspec document by the grammar core. */
function tokenize(text: string): Token[] {
  const out = spawnSync(tokens, { input: text, encoding: 'utf8' });
  if (out.status !== 0 || out.error) throw new Error(`orm-tokens (${tokens}): ${out.stderr ?? out.error}`);
  return JSON.parse(out.stdout) as Token[];
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Renders one dbspec document as the HTML of a highlighted code block. */
export function renderDbs(text: string): string {
  const lines = text.replace(/\n$/, '').split('\n');
  const byLine = new Map<number, Token[]>();
  for (const t of tokenize(text)) {
    const list = byLine.get(t.line) ?? [];
    list.push(t);
    byLine.set(t.line, list);
  }
  const html = lines.map((line, n) => {
    let out = '';
    let at = 0;
    for (const t of byLine.get(n + 1) ?? []) {
      out += escape(line.slice(at, t.start));
      out += `<span class="dbs-${t.cls}">${escape(line.slice(t.start, t.end))}</span>`;
      at = t.end;
    }
    return out + escape(line.slice(at));
  });
  return `<pre class="dbs" v-pre><code>${html.join('\n')}</code></pre>`;
}
