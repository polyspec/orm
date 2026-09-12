import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, Row, openSqlite, registerRow } from '../../clients/typescript/dist/index.js';
import { QueryKind } from '../../clients/typescript/dist/gen/proto/orm/compiler/v1/compiler_pb.js';

class RootRow extends Row {
  static entity() { return 'root_in_test'; }
  static primaryKeys() { return ['id']; }
  static columns() { return { id: 'i64' }; }
}
registerRow('root_in_test', RootRow);

const dir = await mkdtemp(join(tmpdir(), 'orm-root-in-'));
const path = join(dir, 'test.sqlite');
const connection = openSqlite(path);
try {
  await connection.execute('CREATE TABLE root_in_test (id INTEGER PRIMARY KEY)', []);
  for (let id = 1; id <= 1000; id++) await connection.execute('INSERT INTO root_in_test (id) VALUES (?)', [id]);
  const compiler = {
    async metadata() { return { schemaHash: 'root-in', dialect: 'sqlite', irVersion: 1 }; },
    async compile(request) {
      const predicate = request.root?.where?.items?.[0]?.value?.value;
      const parameters = predicate?.parameters ?? [];
      const isCount = request.kind === QueryKind.COUNT;
      return {
        schemaHash: 'root-in', kind: request.kind,
        steps: [{ id: 0, role: isCount ? 'count' : 'root', sql: `${isCount ? 'SELECT COUNT(*)' : 'SELECT id'} FROM root_in_test WHERE id IN (${parameters.map(() => '?').join(',')})`, binds: parameters.map(parameter => ({ source: 'param', parameter, transform: '', name: '', step: 0, column: '', hostStyles: [], columnType: '' })), assemble: isCount ? undefined : { entity: 'root_in_test', alias: 'r', columns: [{ index: 0, name: 'id', column: 'id', type: 'i64', styles: [], hidden: false }], children: [], key: [{ column: 'id', index: 0 }] } }],
      };
    },
  };
  const db = new Db(connection, { schemaHash: 'root-in', compiler });
  const request = { ir_version: 1, schema_hash: 'root-in', kind: 'count', entity: 'root_in_test', where: { items: [{ pred: { column: 'id', op: 'in', ps: Array.from({ length: 1000 }, (_, index) => index) } }] }, n_params: 1000 };
  const count = await db.executeRequest(request, Array.from({ length: 1000 }, (_, index) => index + 1));
  if (count !== 1000) throw new Error(`root IN count=${count}, want 1000`);
  const rows = await db.executeRequest({ ...request, kind: 'all' }, Array.from({ length: 1000 }, (_, index) => index + 1));
  if (rows.length !== 1000) throw new Error(`root IN rows=${rows.length}, want 1000`);
  await db.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
