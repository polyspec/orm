// schema_install coverage: 이미 설치된 bench manifest 의 설치는 아무것도 바꾸지 않고, table 일부만
// 있는 문서 집합의 설치는 CONFIG 로 거부되어 없는 table 을 만들지 않는지 확인한다.
import assert from 'node:assert/strict';
import { Author, Db, SCHEMA, connect, dbspecManifest, parseDbspec } from '../dist/index.js';
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

/** The external document of a set that uses the table user of the bench database. */
const externalUser = `dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}
`;

/** A document set that uses user of externalUser and owns only coverage_external_post. */
const externalMember = `dbspec 1 coverage_external

use bench_user { user }

table coverage_external_post {
  seq i64 identity
  user_seq i64
  primary key (seq)
  index ix_coverage_external_post_user (user_seq)
  foreign key fk_coverage_external_post_user (user_seq) references user (seq)
}
`;

/** The generated schema value of externalMember with an external document. */
function externalSchema(external) {
  const member = parseDbspec(externalMember, { bench_user: external }).document;
  const user = Object.freeze({ ...parseDbspec(external, { coverage_external: externalMember }).document, external: true });
  const { manifest } = dbspecManifest([member, user]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash, externalText: manifest.externalText };
}

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

  // 외부 문서를 쓰는 set의 연결은 외부 table을 database에서 확인한다. 같은 table이면 연결하고, 외부 문서의 column이
  // database에 없으면 연결과 install이 CONFIG이며 소유한 table을 만들지 않는다.
  async schema_install_external_documents() {
    await withDatabase(async (db, driver, dsn) => {
      const connected = await Db.connectSchema(dsn, externalSchema(externalUser));
      await connected.close();
      const drifted = externalSchema(externalUser.replace('  name varchar(191)\n', '  name varchar(191)\n  coverage_missing varchar(8) null\n'));
      const want = 'the tables that the set uses from external documents differ from the database: column user.coverage_missing does not exist';
      let caught = null;
      try { await (await Db.connectSchema(dsn, drifted)).close(); } catch (error) { caught = error; }
      assert.ok(caught?.code === 'CONFIG' && caught.message.includes(want), `connect with a drifted external table: ${caught}`);
      caught = null;
      try { await db.utils().schema().install(drifted); } catch (error) { caught = error; }
      assert.ok(caught?.code === 'CONFIG' && caught.message.includes(want), `install with a drifted external table: ${caught}`);
      assert.equal(await tableExists(driver, dsn, 'coverage_external_post'), false, 'the rejected install created table coverage_external_post');
    });
  },
}, 300_000);
