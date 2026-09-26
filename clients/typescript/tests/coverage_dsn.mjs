import '../dist/models/models.js';
import { Db, OrmError } from '../dist/index.js';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 3 || process.argv[2] !== 'dsn_connection') {
  throw new Error('usage: coverage_dsn.mjs dsn_connection');
}
const { ORM_FEATURE_DATABASE: driver, ORM_FEATURE_DSN: dsn } = process.env;
if (!['mysql', 'postgres', 'sqlite'].includes(driver) || !dsn) {
  throw new Error('selected database and DSN are required');
}
const schemaPath = fileURLToPath(new URL('../../../schema/schema.json', import.meta.url));
try {
  await Db.connect('invalid://database', schemaPath);
  throw new Error('unsupported DSN scheme was accepted');
} catch (error) {
  if (!(error instanceof OrmError) || error.code !== 'CONFIG') throw error;
}
const db = await Db.connect(dsn, schemaPath);
try {
  if (db.driver !== driver) throw new Error(`DSN selected ${db.driver}, want ${driver}`);
} finally {
  await db.close();
}
console.log('CASE dsn_connection PASS');
