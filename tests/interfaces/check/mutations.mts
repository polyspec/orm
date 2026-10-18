// Source mutations for --self-test. It reads the actual modified source files with the extractor. Modifying an already-extracted JSON map only tests the comparison, so
// it can hide an extractor that misses declarations.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOwners, checkProhibitedSymbols, differences } from './contract.mts';
import { checkProhibitedCalls, extract, type Tools } from './extract.mts';
import type { Owner } from './manifest.mts';

type Fixture = { ext: string; source: string; changes: [string, string][]; prohibited: [string, string]; call: string };

const FIXTURES: Record<string, Fixture> = {
  go: {
    ext: 'go',
    source: `package fixture
type Binding struct{}
type Row struct{}
type Query struct { binding Binding }
func (q *Query) Gets() ([]Row, error) { return nil, nil }
`,
    changes: [
      ['Gets()', 'Missing()'],
      ['Gets()', 'Gets(db Binding)'],
      ['([]Row, error)', '(Row, error)'],
      ['(q *Query)', '(q *Row)'],
      ['binding Binding', 'binding *Row'],
      ['type Query struct', 'type Other struct'],
      ['binding Binding', 'binding Binding; controller string'],
    ],
    prohibited: ['Gets()', 'MultiStatement(value bool)'],
    call: 'func attempted(q *Query) { q.MultiStatement(true) }',
  },
  php: {
    ext: 'php',
    source: `<?php
class Binding {}
class Row {}
class Query {
    private Binding $binding;
    public function gets(): array { return []; }
}
`,
    changes: [
      ['function gets()', 'function missing()'],
      ['function gets()', 'function gets(Binding $db)'],
      ['gets(): array', 'gets(): Row'],
      ['private Binding $binding', 'private Row $binding'],
      ['public function gets', 'private function gets'],
      ['class Query', 'class Other'],
      ['private Binding $binding;', 'private Binding $binding; private string $controller;'],
    ],
    prohibited: ['function gets()', 'function multi_statement(bool $value)'],
    call: '$query->multi_statement(true);',
  },
  rust: {
    ext: 'rs',
    source: `pub struct Binding;
pub struct Row;
pub struct Query { binding: Binding }
impl Query { pub async fn gets(&mut self) -> Result<Vec<Row>, Error> { todo!() } }
`,
    changes: [
      ['fn gets', 'fn missing'],
      ['gets(&mut self)', 'gets(&mut self, db: Binding)'],
      ['Result<Vec<Row>, Error>', 'Result<Row, Error>'],
      ['impl Query', 'impl Row'],
      ['binding: Binding', 'binding: Row'],
      ['gets(&mut self)', 'gets(self)'],
      ['binding: Binding', 'binding: Binding, controller: String'],
    ],
    prohibited: ['fn gets(&mut self)', 'fn multi_statement(&mut self, value: bool)'],
    call: 'fn attempted(q: &mut Query) { q.multi_statement(true); }',
  },
  typescript: {
    ext: 'ts',
    source: `class Binding {}
class Row {}
class Query {
    private binding: Binding;
    public async gets(): Promise<Row[]> { return []; }
}
`,
    changes: [
      ['gets()', 'missing()'],
      ['gets()', 'gets(db: Binding)'],
      ['Promise<Row[]>', 'Promise<Row>'],
      ['private binding: Binding', 'private binding: Row'],
      ['public async gets', 'private async gets'],
      ['class Query', 'class Other'],
      ['private binding: Binding;', 'private binding: Binding; private controller: string;'],
    ],
    prohibited: ['gets()', 'multiStatement(value: boolean)'],
    call: 'function attempted(q: Query) { q.multiStatement(true); }',
  },
  python: {
    ext: 'py',
    source: `class Binding:
    pass


class Row:
    pass


class Query:
    binding: Binding

    def gets(self) -> list[Row]:
        return []
`,
    changes: [
      ['def gets(self)', 'def missing(self)'],
      ['def gets(self)', 'def gets(self, db: Binding)'],
      ['-> list[Row]', '-> Row'],
      ['binding: Binding', 'binding: Row'],
      ['def gets', 'def _gets'],
      ['class Query', 'class Other'],
      ['binding: Binding', 'binding: Binding\n    controller: str'],
    ],
    prohibited: ['def gets(self)', 'def multi_statement(self, value: bool)'],
    call: 'q.multi_statement(True)',
  },
};

/**
 * parserMutations checks whether each lang extractor reads different declarations for each mutation of the fixture source, whether an added field trips the common owner contract,
 * and whether a public multi_statement and its call are rejected.
 */
export async function parserMutations(signal: AbortSignal | undefined, toolRoot: string, lang: string, tools: Tools): Promise<void> {
  const f = FIXTURES[lang];
  if (f === undefined) throw new Error(`unsupported language ${lang}`);
  const dir = mkdtempSync(join(tmpdir(), 'orm-interface-mutation-'));
  try {
    const path = join(dir, `fixture.${f.ext}`);
    const read = (source: string) => {
      writeFileSync(path, source, { mode: 0o600 });
      return extract(signal, dir, lang, ['.'], tools, toolRoot);
    };
    const baseline = await read(f.source);
    if (Object.keys(baseline).length < 4) throw new Error(`${lang} parser returned too few fixture declarations`);
    const owner: Owner = { id: 'Query', for: 'once', native: { [lang]: { symbol: `fixture.${f.ext}::Query`, fields: ['binding'] } } };
    const unmodified = checkOwners(lang, baseline, [owner]);
    if (unmodified.length !== 0) throw new Error(`${lang} unmodified fixture failed the owner contract: [${unmodified.join(' ')}]`);
    for (const [i, [from, to]] of f.changes.entries()) {
      if (!f.source.includes(from)) throw new Error('invalid mutation fixture');
      const got = await read(f.source.replace(from, () => to));
      if (differences(baseline, got).length === 0) throw new Error(`${lang} parser missed source mutation ${i} (${to})`);
      if (i === f.changes.length - 1 && checkOwners(lang, got, [owner]).length === 0) throw new Error(`${lang} extra field passed the shared owner contract`);
    }
    const withProhibitedMethod = await read(f.source.replace(f.prohibited[0], () => f.prohibited[1]));
    const prohibited = checkProhibitedSymbols(lang, withProhibitedMethod, ['multi_statement']);
    if (prohibited.length !== 1) throw new Error(`${lang} public multi_statement mutation passed the interface check: [${prohibited.join(' ')}]`);
    writeFileSync(path, `${f.source}\n${f.call}\n`, { mode: 0o600 });
    const calls = checkProhibitedCalls(lang, readFileSync(path, 'utf8'));
    if (calls.length !== 1) throw new Error(`${lang} multi_statement call passed interface validation: [${calls.join(' ')}]`);
    const clean = checkProhibitedCalls(lang, f.source);
    if (clean.length !== 0) throw new Error(`${lang} unmodified fixture contains a prohibited call: [${clean.join(' ')}]`);
    console.log(`${lang}: ${f.changes.length} source mutations, public multi_statement and attempted call rejected`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
