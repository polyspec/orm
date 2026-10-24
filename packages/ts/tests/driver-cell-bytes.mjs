// A native MySQL binary cell reaches the model through the driver's row decoder without losing its bytes.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { CORE, Db, Model, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

// Requirements: INT-5, PRT-69.
caseTest('driver-cell/bytes/mysql', COMPUTE, async () => {
  const source = Uint8Array.from([0x00, 0x7f, 0x80, 0xff, 0x41]);
  const parsed = parseDbspec('dbspec 1 native_cell\n\ntable byte_cell {\n  id i32\n  body bytes\n  primary key (id)\n}\n', {});
  assert.ok(parsed.document);
  const manifest = dbspecManifest([parsed.document]).manifest;
  const model = registerModel(manifest.manifestText, manifest.manifestHash);
  const entity = model.entities.get('byte_cell');
  assert.ok(entity);
  const ByteCell = class extends Model {};
  ByteCell.entity = { model, entity, create: core => new ByteCell(core) };
  const db = new Db({ name: 'mysql' }, 'UTC', {});
  db.plan = async () => ({
    plan: {
      steps: [{
        id: 0,
        role: 'main',
        sql: 'SELECT native-bytes',
        tables: [],
        bind_slots: [],
        decode: [],
        assemble: {
          entity: 'byte_cell',
          alias: 'byte_cell',
          columns: [
            { index: 0, name: 'id', column: 'id', type: 'i32', styles: [], hidden: false },
            { index: 1, name: 'body', column: 'body', type: 'bytes', styles: [], hidden: false },
          ],
          children: [],
          key: [{ column: 'id', index: 0 }],
        },
      }],
    },
  });
  db.runStep = async () => ({ rows: [[1, source]], affected: 0, insertId: null, columns: [] });

  const request = new ByteCell().connect(db);
  request[CORE].addColumn('body');
  const row = await request.get();
  assert.ok(row);
  assert.deepEqual(row[CORE].column('body'), source);
});
