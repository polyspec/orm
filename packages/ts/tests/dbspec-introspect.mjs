// dbspec introspection cases (tests/dbspec/introspect.json, docs/dialects.md "Introspection"): every case is applied
// with its statements to an empty database, schema or file and expects its document and unsupported objects. Each case
// is a top-level test named by its id; the round trips of the schema documents run in dbspec-introspect-round-trip.mjs.
//
// Usage: ORM_TEST_MYSQL_DSN=... ORM_TEST_POSTGRES_DSN=... node --test packages/ts/tests/dbspec-introspect.mjs (after the build)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emitDbspec, introspectDbspec, renderDbspec } from '../dist/dbspec/index.js';
import { CONNECTION_RULES, parseSet, root, text, vector, withDatabase } from './introspect_case.mjs';

const cases = JSON.parse(readFileSync(new URL('tests/dbspec/introspect.json', root), 'utf8')).cases;
assert(cases.length > 0, 'introspect cases');
for (const c of cases) {
  vector(c.id, async () => {
    const sources = {};
    for (const [name, lines] of Object.entries(c.documents)) sources[name] = text(lines);
    const rendered = renderDbspec(parseSet(c.id, sources), c.dialect);
    assert.deepEqual(rendered.diagnostics, []);
    await withDatabase(c.dialect, async (connection, exec, name) => {
      // {schema}는 이 case의 database 또는 schema 이름이다.
      const statements = c.statements.map(sql => sql.replaceAll('{schema}', name));
      for (const sql of [...CONNECTION_RULES[c.dialect], ...rendered.statements, ...statements]) await exec(connection, sql);
      const { document, unsupported } = await introspectDbspec(connection, c.dialect, 'introspected');
      assert.equal(emitDbspec(document), text(c.document));
      assert.deepEqual(unsupported.map(u => [u.kind, u.table, u.name]), c.unsupported.map(w => w.slice(0, 3)));
      for (const u of unsupported) assert(u.reason.length > 0, `reason of ${u.kind} ${u.table} ${u.name}`);
      // 네 번째 원소는 reason이 포함해야 하는 rule이다. 없으면 reason은 비교하지 않는다.
      c.unsupported.forEach((w, i) => {
        if (w.length === 4) assert(unsupported[i].reason.includes(w[3]), `reason of ${w.slice(0, 3).join(' ')}: want rule ${w[3]}, got ${unsupported[i].reason}`);
      });
    });
  });
}

