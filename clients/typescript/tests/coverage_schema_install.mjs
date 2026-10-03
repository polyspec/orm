// schema_install coverage: 이미 설치된 bench manifest 의 설치는 아무것도 바꾸지 않고, table 일부만
// 있는 문서 집합의 설치는 CONFIG 로 거부되어 없는 table 을 만들지 않는지 확인한다.
import assert from 'node:assert/strict';
import { Author, SCHEMA, connect, dbspecManifest, parseDbspec } from '../dist/index.js';
import { featureDatabase, runCases, tableExists } from './coverage_case.mjs';

const partial = `dbspec 1 partial

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}

table coverage_install_missing {
  seq i64 identity
  primary key (seq)
}
`;

/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/** Opens the selected database and runs the case on it. */
async function withDatabase(body) {
  const { driver, dsn } = featureDatabase();
  const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
  try {
    assert.equal(db.driver, driver);
    await body(db, driver, dsn);
  } finally { await db.close(); }
}

await runCases('coverage_schema_install.mjs', {
  async schema_install_existing() {
    await withDatabase(async db => {
      await db.utils().schema().install(SCHEMA);
      assert.equal(await new Author().connect(db).getCount(), 100000, 'the installed tables keep their rows');
    });
  },

  async schema_install_partial() {
    await withDatabase(async (db, driver, dsn) => {
      assert.equal(await tableExists(driver, dsn, 'coverage_install_missing'), false, 'coverage_install_missing does not exist before the case');
      let caught = null;
      try { await db.utils().schema().install(schemaOf(partial)); } catch (error) { caught = error; }
      assert.equal(caught?.code, 'CONFIG', `install of a partly present document set: ${caught}`);
      assert.equal(await tableExists(driver, dsn, 'coverage_install_missing'), false, 'the missing table was not created');
    });
  },
}, 300_000);
