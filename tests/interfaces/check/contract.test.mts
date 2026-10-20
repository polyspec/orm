// Checks declarations against the common contract: nested drift of records, name forms of prohibited symbols, prohibited calls, PHP records and relative types,
// and declarations of extensions (PHP extension).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../../testcase.mts';
import { checkProhibitedSymbols, checkRecords, differences } from './contract.mts';
import { checkCallsInRoots, extract } from './extract.mts';
import { mark, readManifest, type ContractRecord, type Manifest, type Symbols } from './manifest.mts';

// symbolsOf gives each signature of a map the exported status of a public declaration.
const symbolsOf = (signatures: Record<string, string>): Symbols => Object.fromEntries(Object.entries(signatures).map(([key, value]) => [key, mark(value)]));
import { checkExtension } from './main.mts';

const root = resolve(import.meta.dirname, '../../..');

function requirePhp(): void {
  try {
    execFileSync('php', ['--version'], { stdio: 'ignore' });
  } catch {
    assert.fail('php CLI is required; tool tests never skip; install the PHP of .php-version');
  }
}

function withTemp<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orm-interface-test-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

caseTest('a common record rejects recaptured native drift', COMPUTE, () => {
  const records: ContractRecord[] = [
    { id: 'Query', native: { go: 'ir.go::Query' }, fields: { entity: 'text', group: 'Group' } },
    { id: 'Group', native: { go: 'ir.go::Group' }, fields: { items: 'list<text>' } },
  ];
  const symbols: Symbols = symbolsOf({ 'ir.go::Query#wire': '{"entity":"text","group":"Group"}', 'ir.go::Group#wire': '{"items":"list<text>"}' });
  assert.deepEqual(checkRecords('go', symbols, records), []);
  for (const changed of ['{}', '{"items":"text"}', '{"items":"list<integer>"}', '{"items":"list<text>","controller":"text"}']) {
    symbols['ir.go::Group#wire'] = mark(changed);
    assert.notDeepEqual(checkRecords('go', symbols, records), [], `nested drift accepted even with recaptured native symbol snapshot ${changed}`);
  }
});

caseTest('prohibited symbols use the name forms of each language', COMPUTE, () => {
  for (const symbols of [
    { 'Query.MultiStatement': 'func(bool) Query' },
    { 'Query::multi_statement': 'public function multi_statement(bool): Query' },
    { 'Query.multiStatement': 'multiStatement(value: boolean): Query' },
  ]) {
    assert.equal(checkProhibitedSymbols('test', symbolsOf(symbols), ['multi_statement']).length, 1);
  }
  assert.deepEqual(checkProhibitedSymbols('test', symbolsOf({ 'Query.stream': 'func(visitor) StreamResult' }), ['multi_statement']), [], 'unrelated symbol rejected');
});

caseTest('attempted multi_statement calls fail the interface validation', COMPUTE, () => {
  for (const [language, suffix, call, safe] of [
    ['go', '.go', 'query.MultiStatement(true)', 'query.Gets()'],
    ['php', '.php', '$query->multi_statement(true)', '$query->gets()'],
    ['rust', '.rs', 'query.multi_statement(true)', 'query.gets()'],
    ['typescript', '.ts', 'query.multiStatement(true)', 'query.gets()'],
  ] as const) {
    withTemp(dir => {
      const path = join(dir, `client${suffix}`);
      writeFileSync(path, safe, { mode: 0o600 });
      assert.deepEqual(checkCallsInRoots(dir, language, ['.']), [], `${language} safe call`);
      writeFileSync(path, call, { mode: 0o600 });
      assert.equal(checkCallsInRoots(dir, language, ['.']).length, 1, `${language} prohibited call`);
    });
  }
});

caseTest('PHP relative types resolve to their classes', PROCESS, async ({ signal }) => {
  requirePhp();
  const source = `<?php
namespace Fixture;
class Base {}
interface Left {}
interface Right {}
class Row extends Base {
    private ?self $current;
    public function same(self $row): self {}
    public function optional(?self $row): ?self {}
    public function base(parent $row): parent {}
    public function late(): static {}
    public function union(self|int $row): self|int {}
    public function intersection(Left&Right $row): Left&Right {}
    public function dnf((Left&Right)|self $row): (Left&Right)|self {}
}
`;
  const dir = mkdtempSync(join(tmpdir(), 'orm-interface-test-'));
  try {
    const read = (text: string) => {
      writeFileSync(join(dir, 'fixture.php'), text, { mode: 0o600 });
      return extract(signal, dir, 'php', ['.'], {}, root);
    };
    const got = await read(source);
    const prefix = 'fixture.php::Fixture\\Row::';
    for (const [name, want] of Object.entries({
      $current: 'private ?Fixture\\Row',
      same: 'public function same(Fixture\\Row $row): Fixture\\Row',
      optional: 'public function optional(?Fixture\\Row $row): ?Fixture\\Row',
      base: 'public function base(Fixture\\Base $row): Fixture\\Base',
      late: 'public function late(): static',
    })) {
      assert.equal(got[prefix + name]?.signature, want, name);
    }
    const qualified = source.replaceAll('self', '\\Fixture\\Row').replaceAll('parent', '\\Fixture\\Base');
    assert.deepEqual(differences(got, await read(qualified)), [], 'relative and qualified types differ');
    for (const replacement of ['static', '\\Fixture\\Base']) {
      const other = await read(source.replace('same(self $row): self', `same(self $row): ${replacement}`));
      assert.notEqual(got[`${prefix}same`]?.signature, other[`${prefix}same`]?.signature, `normalization hid a change from self to ${replacement}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

caseTest('a PHP record source mutation changes the extracted wire', PROCESS, async ({ signal }) => {
  requirePhp();
  const dir = mkdtempSync(join(tmpdir(), 'orm-interface-test-'));
  try {
    const read = (kindType: string, itemsType: string, extra: boolean) => {
      let records = `'Request' => ['kind' => '${kindType}', 'items' => '${itemsType}']`;
      if (extra) records += ", 'Extra' => ['kind' => 'string']";
      writeFileSync(join(dir, 'fixture.php'), `<?php\nnamespace Polyspec\\Orm;\nfinal class Validator { private const RECORDS = [${records}]; }\n`, { mode: 0o600 });
      return extract(signal, dir, 'php', ['.'], {}, root);
    };
    const key = 'fixture.php::Polyspec\\Orm\\Validator::Request#wire';
    const before = await read('string', 'list<int>', false);
    assert.equal(before[key]?.signature, '{"kind":"text","items":"list<integer>"}', 'PHP record declaration was not extracted');
    const contract: ContractRecord[] = [{ id: 'IRRequest', native: { php: 'fixture.php::Polyspec\\Orm\\Validator::Request' }, fields: { kind: 'text', items: 'list<integer>' } }];
    assert.deepEqual(checkRecords('php', before, contract), [], 'unaltered PHP record failed');
    const after = await read('int', 'list<int>', false);
    assert.equal(after[key]?.signature, '{"kind":"integer","items":"list<integer>"}', 'PHP record type mutation was not detected');
    assert.notDeepEqual(differences(before, after), []);
    assert.notDeepEqual(checkRecords('php', after, contract), [], 'PHP record type mutation passed the common record contract');
    assert.notDeepEqual(checkRecords('php', await read('string', 'list<string>', false), contract), [], 'PHP nested record type mutation passed the common record contract');
    assert.notDeepEqual(checkRecords('php', await read('string', 'list<int>', true), contract), [], 'undeclared PHP record passed the common record contract');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

caseTest('the PHP records match the common contract', PROCESS, async ({ signal }) => {
  requirePhp();
  const manifest = readManifest(join(root, 'contracts/interfaces.json'));
  const got = await extract(signal, root, 'php', manifest.languages?.['php']?.roots ?? [], {}, root);
  assert.deepEqual(checkRecords('php', got, manifest.records ?? []), [], 'PHP record contract differs');
});

// Checks that it accepts the stub with the PHP extension (php-extension) check recorded, and rejects a stub that differs from the common contract, an adapter the extension does not write,
// or a different symbol snapshot. Each case copies the stub and snapshot into a temporary root and changes them there.
caseTest('the extension declarations are checked against the contract', PROCESS, async ({ signal }) => {
  requirePhp();
  const m = readManifest(join(root, 'contracts/interfaces.json'));
  const e = m.extensions?.['php-extension'];
  assert.ok(e, 'contracts/interfaces.json declares no php-extension');
  // The extension has one stub (S10), the one the cases change.
  const stubRoot = e.roots?.[0] ?? '', stubPath = join(stubRoot, 'polyspec_orm.stub.php'), symbolsPath = e.symbols ?? '';
  const stub = readFileSync(join(root, stubPath), 'utf8'), snapshot = readFileSync(join(root, symbolsPath), 'utf8');
  // check verifies the extension in the temporary root where the stub and snapshot were changed. extract runs php.php in that root, so it is kept in the same place.
  const check = async (stubSource: string, snapshotSource: string, manifest: Manifest): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'orm-interface-test-'));
    try {
      for (const [path, content] of [[stubPath, stubSource], [symbolsPath, snapshotSource], ['packages/php/testing/interfaces/php.php', readFileSync(join(root, 'packages/php/testing/interfaces/php.php'), 'utf8')]] as const) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      const extension = manifest.extensions?.['php-extension'] ?? {};
      await checkExtension(dir, 'php-extension', extension, manifest, undefined, false, signal, () => {});
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal(await check(stub, snapshot, m), '', 'the recorded stub and snapshot are refused');
  const mutations: Record<string, { stub?: string; snapshot?: string; manifest?: (m: Manifest) => Manifest; want: string }> = {
    'a return type that differs from the contract': {
      stub: stub.replace('public static function emit(Document $document): string', 'public static function emit(Document $document): ?string'),
      want: 'php-extension/Dbspec.emit',
    },
    'a missing result field': { stub: stub.replace('    public string $externalText;\n', ''), want: 'php-extension/DbspecManifest: missing externalText' },
    'an adapter that the extension does not list': {
      manifest: original => ({
        ...original,
        rules: (original.rules ?? []).map(r => (r.id === 'Model.gets' && r.native?.['php'] ? { ...r, native: { ...r.native, 'php-extension': r.native['php'] } } : r)),
      }),
      want: 'Model.gets has a php-extension adapter that the extension does not list',
    },
    'a snapshot that differs from the declarations': { snapshot: snapshot.replace('public readonly int', 'public readonly string'), want: 'php-extension: changed' },
  };
  for (const [name, mutation] of Object.entries(mutations)) {
    const message = await check(mutation.stub ?? stub, mutation.snapshot ?? snapshot, mutation.manifest ? mutation.manifest(m) : m);
    assert.ok(message.includes(mutation.want), `${name}: want an error with ${JSON.stringify(mutation.want)}, got ${JSON.stringify(message)}`);
  }
});
