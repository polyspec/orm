// Checks that paramUses lists, for each request parameter, the logical type and column of the slot that parameter fills.
// A markdown IR executor message writes each parameter in the form of its type (docs/spec/protocol.md §5 Parameters). The Go
// engine/ir/params_test.go TestParamUses has the same cases.
//
// Usage: node packages/ts/tests/param-uses.mjs (after npm run typescript:build)
import { isDeepStrictEqual } from 'node:util';
import { COMPUTE, caseTest } from '../../../tests/testcase.mts';
import { dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { paramUses } from '../dist/engine/params.js';
import { validate } from '../dist/engine/validate.js';

const document = `dbspec 1 params

table owners {
  id varchar(16)
  name varchar(32)
  primary key (id)
}

table notes {
  id i64 identity
  owner varchar(16)
  title varchar(64)
  born date null
  at datetime(3)
  version datetime(6) null
  primary key (id)
  index ix_notes_owner (owner)
  foreign key fk_notes_owner (owner) references owners (id)
}
`;

/** Reduces each use to [type, column name] to make comparison easy. */
function usesOf(uses) {
  return uses.map(list => list.map(use => [use.type, use.column?.name ?? '']));
}

caseTest('param-uses/kinds', COMPUTE, () => {
  const parsed = parseDbspec(document, {});
  if (parsed.document === null) throw new Error(JSON.stringify(parsed.diagnostics));
  const { manifest } = dbspecManifest([parsed.document]);
  const m = registerModel(manifest.manifestText, manifest.manifestHash);
  const check = (name, request, want) => {
    validate(m, request);
    const got = usesOf(paramUses(m, request));
    if (!isDeepStrictEqual(got, want)) throw new Error(`${name} uses = ${JSON.stringify(got)}\nwant ${JSON.stringify(want)}`);
  };
  check('read', {
    ir_version: 1, manifest_hash: m.manifestHash, kind: 'all', n_params: 9, entity: 'notes',
    where: { items: [
      { pred: { column: 'title', op: 'eq', p: 0 } },
      { pred: { conn: 'and', column: 'born', op: 'between', ps: [1, 2] } },
      { pred: { conn: 'and', column: 'at', op: 'eq', fn: { name: 'year' }, p: 3 } },
      { pred: { conn: 'and', column: 'at', op: 'gt', value: { name: 'days_ago', ps: [4] } } },
      { pred: { conn: 'and', column: 'title', op: 'contains', p: 5 } },
      { pred: { conn: 'and', column: 'at', op: 'eq', fn: { name: 'date' }, p: 6 } },
      { pred: { conn: 'and', column: 'at', op: 'lt', value: { name: 'seconds_later', ps: [7] } } },
    ] },
    relations: [{ rel: 'owner_model', kind: 'one', keys: [{ left: 'owner', right: 'id' }], query: { entity: 'owners', if_parent: { column: 'title', p: 8 } } }],
  }, [
    [['varchar', 'title']],
    [['date', 'born']],
    [['date', 'born']],
    [['i64', '']],
    [['i32', '']],
    [['text', '']],
    [['date', '']],
    [['f64', '']],
    [['varchar', 'title']],
  ]);
  check('insert', {
    ir_version: 1, manifest_hash: m.manifestHash, kind: 'insert', n_params: 6, entity: 'notes',
    set: [{ column: 'owner', p: 0 }, { column: 'title', p: 1 }, { column: 'at', p: 2 }],
    rows: [[3, 4, 5]],
  }, [
    [['varchar', 'owner']], [['varchar', 'title']], [['datetime', 'at']],
    [['varchar', 'owner']], [['varchar', 'title']], [['datetime', 'at']],
  ]);
  check('update', {
    ir_version: 1, manifest_hash: m.manifestHash, kind: 'update', n_params: 3, entity: 'notes',
    where: { items: [{ pred: { column: 'id', op: 'eq', p: 0 } }] },
    set: [{ column: 'title', p: 1 }],
    optimistic: { column: 'version', p: 2 },
  }, [[['i64', 'id']], [['varchar', 'title']], [['datetime', 'version']]]);
});
