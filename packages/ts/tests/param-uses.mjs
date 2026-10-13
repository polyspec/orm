// paramUses가 request parameter마다 그 parameter가 채우는 slot의 logical type과 column을 나열하는지 확인한다.
// markdown IR executor message는 각 parameter를 그 type의 form으로 쓴다(docs/protocol.md §5 Parameters). Go의
// engine/ir/params_test.go TestParamUses와 같은 case다.
//
// 사용: node packages/ts/tests/param-uses.mjs (npm run typescript:build 뒤)
import { isDeepStrictEqual } from 'node:util';
import { COMPUTE, cases } from '../../../tests/testcase.mjs';
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

/** 비교를 쉽게 하려고 use를 [type, column 이름]으로 줄인 것이다. */
function usesOf(uses) {
  return uses.map(list => list.map(use => [use.type, use.column?.name ?? '']));
}

const run = cases();
await run.run('param-uses/kinds', COMPUTE, () => {
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
run.finish();
