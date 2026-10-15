// The `dbs` fence of the documentation site (docs/editor.md "Ecosystem mechanisms"): a fenced block whose info string
// is `dbs` holds one dbspec document, and the language service gives its tokens and diagnostics. A document of a set
// is written `dbs set=<set> document=<name>`; every fence of the page with the same set is the set of the others, keyed
// by its declared name, which the parser checks against the header through its `use` rule. A fence with a diagnostic
// fails the build, so every published example is a verified document.
import { openDocument } from '@polyspec/dbspec-language';

/** The fence of one markdown-it token: its document text and its set and name, when it declares them. */
interface DbsFence {
  readonly text: string;
  readonly set: string | null;
  readonly document: string | null;
  readonly line: number;
}

/** The info string of a `dbs` fence, or null for another fence. A malformed `dbs` info string is an error. */
export function dbsInfo(info: string): { set: string | null; document: string | null } | null {
  const words = info.trim().split(/\s+/);
  if (words[0] !== 'dbs') return null;
  const attrs = new Map<string, string>();
  for (const word of words.slice(1)) {
    const at = word.indexOf('=');
    const key = at < 0 ? word : word.slice(0, at);
    if (at < 0 || (key !== 'set' && key !== 'document') || attrs.has(key) || word.length === at + 1) {
      throw new Error(`dbs fence info "${info}": attributes are set=<set> and document=<name>, each once`);
    }
    attrs.set(key, word.slice(at + 1));
  }
  if (attrs.has('set') !== attrs.has('document')) {
    throw new Error(`dbs fence info "${info}": a fence of a set declares both set= and document=`);
  }
  return { set: attrs.get('set') ?? null, document: attrs.get('document') ?? null };
}

/** The `dbs` fences of a page's tokens, in order. */
export function dbsFences(tokens: readonly { type: string; info: string; content: string; map: [number, number] | null }[]): DbsFence[] {
  const fences: DbsFence[] = [];
  for (const token of tokens) {
    if (token.type !== 'fence') continue;
    const info = dbsInfo(token.info);
    if (info === null) continue;
    if (token.map === null) throw new Error('a dbs fence token has no source map');
    fences.push({ text: token.content, set: info.set, document: info.document, line: token.map[0] + 1 });
  }
  return fences;
}

/** The HTML of one fence: each token in a span of its class; a diagnostic is an error naming the page and line. */
export function renderDbs(fence: DbsFence, fences: readonly DbsFence[], page: string, escape: (text: string) => string): string {
  const set: Record<string, string> = {};
  if (fence.set !== null) {
    for (const other of fences) {
      if (other === fence || other.set !== fence.set) continue;
      const name = other.document;
      if (name === null) throw new Error(`${page}:${other.line}: a fence of dbs set ${fence.set} declares no document`);
      if (Object.hasOwn(set, name)) {
        throw new Error(`${page}:${other.line}: dbs set ${fence.set} declares the document ${name} twice`);
      }
      set[name] = other.text;
    }
  }
  const doc = openDocument(fence.text, { set });
  if (doc.diagnostics.length > 0) {
    const lines = doc.diagnostics.map(d => `${page}:${fence.line + 1 + d.range.start.line}:${d.range.start.character + 1}: ${d.rule}: ${d.message}`);
    throw new Error(`a dbs fence has diagnostics:\n${lines.join('\n')}`);
  }
  const lines = fence.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const byLine = new Map<number, { start: number; end: number; cls: string }[]>();
  for (const token of doc.tokens) {
    const list = byLine.get(token.range.start.line) ?? [];
    list.push({ start: token.range.start.character, end: token.range.end.character, cls: token.class });
    byLine.set(token.range.start.line, list);
  }
  const html = lines.map((line, n) => {
    let out = '';
    let at = 0;
    for (const t of byLine.get(n) ?? []) {
      out += escape(line.slice(at, t.start)) + `<span class="dbs-${t.cls}">${escape(line.slice(t.start, t.end))}</span>`;
      at = t.end;
    }
    return out + escape(line.slice(at));
  });
  return `<pre class="dbs" v-pre><code>${html.join('\n')}</code></pre>\n`;
}
