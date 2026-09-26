import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--dialect' || !['mysql', 'postgres', 'sqlite'].includes(args[1])) {
  throw new Error('usage: decimal_model_db.mjs --dialect mysql|postgres|sqlite');
}
const dialect = args[1];
const name = `DECIMAL_${dialect.toUpperCase()}_DSN`;
const dsn = process.env[name];
if (!dsn) throw new Error(`${name} is required`);
const schemaPath = fileURLToPath(new URL('../../../contracts/fixtures/decimal_schema.json', import.meta.url));
const [{ Db, OrmError }, { activeFor }, { DecimalCase }] = await Promise.all([
  import('../dist/index.js'),
  import('../dist/database.js'),
  import('../dist/models/decimal_fixture/models.js'),
]);

for (const invalid of ['1.00001', '1000000000.0000', 'NaN', 48.045]) {
  try {
    new DecimalCase().setAmount(invalid);
    throw new Error(`invalid decimal ${invalid} was accepted`);
  } catch (error) {
    if (!(error instanceof OrmError) || error.code !== 'CODEC_ENCODE') throw error;
  }
}
try {
  new DecimalCase().setLargeValue(9007199254740992);
  throw new Error('binary64 large decimal input was accepted');
} catch (error) {
  if (!(error instanceof OrmError) || error.code !== 'CODEC_ENCODE') throw error;
}

const db = await Db.connect(dsn, schemaPath);
try {
  if (await new DecimalCase().connect(db).seq(1).getCount() !== 0) {
    throw new Error('decimal fixture row 1 exists before the test');
  }
  const rollback = new Error('decimal fixture rollback');
  try {
    await db.transaction(async () => {
      await new DecimalCase().setSeq(1).setAmount('48.0450').setLargeValue('9007199254740993').create();
      const loaded = await new DecimalCase().seq(1).get();
      if (loaded.getAmount() !== '48.0450' || loaded.getLargeValue() !== '9007199254740993') {
        throw new Error('generated decimal fields lost exact values');
      }
      const row = loaded.toArray();
      if (row.amount !== '48.0450' || row.large_value !== '9007199254740993') {
        throw new Error('decimal row output lost exact values');
      }
      const frame = activeFor(db);
      if (!frame) throw new Error('decimal transaction is absent');
      const sql = `SELECT amount, large_value FROM decimal_case WHERE seq = ${dialect === 'postgres' ? '$1' : '?'}`;
      const stored = (await frame.tx.execute(sql, [1])).rows;
      if (stored.length !== 1 || String(stored[0][0]) !== (dialect === 'sqlite' ? '480450' : '48.0450') || String(stored[0][1]) !== '9007199254740993') {
        throw new Error('database decimal storage lost exact values');
      }
      throw rollback;
    }, { retry: 0 });
    throw new Error('decimal transaction unexpectedly committed');
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (await new DecimalCase().connect(db).seq(1).getCount() !== 0) {
    throw new Error('decimal fixture row remains after rollback');
  }
  console.log(`CASE decimal_${dialect} PASS`);
} finally {
  await db.close();
}
