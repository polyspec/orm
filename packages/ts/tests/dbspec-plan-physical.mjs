// dbspec schema plans on MySQL, PostgreSQL and SQLite (docs/spec/plans.md
// "Verification"). Every case of tests/dbspec/plans.json is applied to an
// empty database, schema or file: the source rendered by renderDbspec, the
// before steps and the planSteps steps before finalize (SQLite with foreign
// keys off, then PRAGMA foreign_key_check returns no row), after which
// introspectDbspec reads the plan's target with nothing unsupported; without
// an irreversible step the rollback statements return to the source schema
// text and the steps run again; then the after steps and the finalize steps
// run, the target is read again and no dbspec$ table or column remains.
//
// Usage: ORM_TEST_MYSQL_DSN=... ORM_TEST_POSTGRES_DSN=... node --test packages/ts/tests/dbspec-plan-physical.mjs (after the build)
import { caseTest } from '../../../tests/testcase.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dbspecManifest, introspectDbspec, parseDbspec, parsePlan, planSteps, renderDbspec } from '../dist/dbspec/index.js';
import { createDbspecPhysicalDatabaseRunner } from './dbspec-physical-database.mjs';

const root = new URL('../../../', import.meta.url);
// TIMEOUT is the deadline (ms) of one case. One plan case creates one database, applies steps, reverts, applies again, finalizes, then drops it.
const TIMEOUT = 60000;
const DIALECTS = ['mysql', 'postgres', 'sqlite'];
// The statements that every client runs on a new connection (packages/go/internal/dialects connectionRules).
const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ["SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};

const mysqlDSN = process.env.ORM_TEST_MYSQL_DSN;
const postgresDSN = process.env.ORM_TEST_POSTGRES_DSN;
if (!mysqlDSN || !postgresDSN) throw new Error('ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN are required; pass TEST_ENV');

const text = lines => lines.join('\n') + '\n';

// vector runs one case with its own deadline and reports its start, result
// and elapsed time.
function vector(name, body) {
  caseTest(name, TIMEOUT, body);
}

const withDatabase = createDbspecPhysicalDatabaseRunner({ namePrefix: 'plan', mysqlDSN, postgresDSN });

// firstValue gives the first column of the first row as text; SQL NULL is NULL.
async function firstValue(session, sql) {
  const rows = await session.rows(sql);
  assert(rows.length > 0, `${sql}: no row`);
  const value = rows[0][0];
  return value === null ? 'NULL' : String(value);
}

// runSteps runs the steps of a case that apply to the dialect: a query
// compares its first value, a failing statement must fail, any other
// statement must succeed.
async function runSteps(session, dialect, steps) {
  for (const step of steps) {
    if (step.dialects && !step.dialects.includes(dialect)) continue;
    if (step.query) assert.equal(await firstValue(session, step.query), step.want, step.query);
    else if (step.fails) await assert.rejects(session.exec(step.sql), `${step.sql}: succeeded; want an error`);
    else await session.exec(step.sql);
  }
}

const cases = JSON.parse(readFileSync(new URL('tests/dbspec/plans.json', root), 'utf8')).cases;
assert(cases.length > 0, 'plan cases');
let runs = 0;

for (const c of cases) {
  for (const dialect of DIALECTS) {
    vector(`${dialect}.plan.${c.id}`, async () => {
      const parsed = parsePlan(text(c.plan));
      assert.deepEqual(parsed.diagnostics, [], 'plan diagnostics');
      const target = dbspecManifest([parsed.plan.schema]).manifest.schemaText;
      let source = null;
      let setup = [];
      if (c.source !== null) {
        const document = parseDbspec(text(c.source), {});
        assert.deepEqual(document.diagnostics, [], 'source diagnostics');
        source = document.document;
        const rendered = renderDbspec([source], dialect);
        assert.deepEqual(rendered.diagnostics, [], 'source render diagnostics');
        setup = rendered.statements;
      }
      const planned = planSteps(source, parsed.plan, dialect);
      assert.deepEqual(planned.diagnostics, [], 'plan step diagnostics');
      const steps = planned.steps;
      const reversible = steps.every(s => s.finalize || s.rollback !== '');
      const sourceText = source === null ? '' : dbspecManifest([source]).manifest.schemaText;
      console.log(`${dialect}.plan.${c.id}: ${steps.length} steps, reversible ${reversible}`);
      await withDatabase(dialect, async session => {
        const schemaIs = async (what, want) => {
          const { document, unsupported } = await introspectDbspec(session.connection, dialect, 'introspected');
          assert.deepEqual(unsupported, [], `${what}: unsupported objects`);
          const got = document.tables.length > 0 ? dbspecManifest([document]).manifest.schemaText : '';
          assert.equal(got, want, `${what}: introspected schema text`);
        };
        // forward runs the steps before finalize. For a restore, the steps with a restore statement
        // run it (there is an added column that rollback hid).
        const forward = async restore => {
          for (const s of steps) {
            if (s.finalize) break;
            await session.exec(restore && s.restore !== '' ? s.restore : s.statement);
          }
          if (dialect === 'sqlite') assert.equal(await firstValue(session, 'SELECT COUNT(*) FROM pragma_foreign_key_check'), '0', 'foreign key check');
        };
        for (const sql of [...CONNECTION_RULES[dialect], ...setup]) await session.exec(sql);
        await runSteps(session, dialect, c.before ?? []);
        // SQLite turns off foreign keys while rebuilding the table and checks them afterward.
        if (dialect === 'sqlite') {
          await session.exec('PRAGMA foreign_keys = OFF');
          await session.exec('PRAGMA legacy_alter_table = OFF');
        }
        await forward(false);
        await schemaIs('applied', target);
        if (reversible) {
          // A rollback that reverts all the way recreates the old table with the hidden added column.
          for (const s of [...steps].reverse()) if (!s.finalize) await session.exec(s.rollbackRestore !== '' ? s.rollbackRestore : s.rollback);
          if (dialect === 'sqlite') assert.equal(await firstValue(session, 'SELECT COUNT(*) FROM pragma_foreign_key_check'), '0', 'foreign key check after rollback');
          await schemaIs('rolled back', sourceText);
          await forward(true);
          await schemaIs('applied again', target);
        }
        if (dialect === 'sqlite') await session.exec('PRAGMA foreign_keys = ON');
        await runSteps(session, dialect, c.after ?? []);
        // finalize also runs with SQLite foreign keys turned off, as apply does.
        if (dialect === 'sqlite') await session.exec('PRAGMA foreign_keys = OFF');
        for (const s of steps) if (s.finalize) await session.exec(s.statement);
        if (dialect === 'sqlite') await session.exec('PRAGMA foreign_keys = ON');
        await schemaIs('finalized', target);
        const hidden = {
          mysql: "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
          postgres:
            "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
          sqlite: "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
        }[dialect];
        assert.equal(await firstValue(session, hidden), '0', 'hidden tables and columns after finalize');
      });
      runs++;
    });
  }
}

// Requirements: PLN-102.
vector('every plan case runs on every dialect', () => {
  assert.equal(runs, cases.length * DIALECTS.length);
  console.log(`plan runs: ${runs} (${cases.length} cases on ${DIALECTS.length} dialects)`);
});
