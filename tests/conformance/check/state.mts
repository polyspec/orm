// The state digest of a bench database: every table's name, columns and rows, independent of row order, and every counter.
// A conformance run compares the digest before and after each runner, so a runner that leaves a row or a counter behind
// fails.
import { createHash } from 'node:crypto';
import { readCounters } from './counters.mts';
import type { StateDatabase } from './database.mts';

// byteOrder sorts as Go sorts strings and byte slices: by bytes.
const byteOrder = (a: Uint8Array, b: Uint8Array): number => Buffer.compare(a, b);

/**
 * stateValue encodes one value of a row by a type mark, a length and the content: the same value gives the same bytes, a
 * different type or value different bytes. Only the types that the connections return are taken: null, an integer
 * (bigint), a real (number), a boolean, bytes and text; any other type is an error.
 */
function stateValue(value: unknown): Buffer {
  if (value === null) return Buffer.from('n');
  if (typeof value === 'bigint') return Buffer.from(`i${value};`);
  if (typeof value === 'number') return Buffer.from(`f${value};`);
  if (typeof value === 'boolean') return Buffer.from(value ? 't' : 'F');
  if (value instanceof Uint8Array) return Buffer.concat([Buffer.from(`b${value.length}:`), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from(`s${bytes.length}:`), bytes]);
  }
  throw new Error(`unsupported state value type ${typeof value}`);
}

/** snapshotDatabase is the hex SHA-256 digest of the tables, their rows and the counters of the database. */
export async function snapshotDatabase(db: StateDatabase, driver: string): Promise<string> {
  let namesQuery: string;
  switch (driver) {
    case 'mysql':
      namesQuery = "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name";
      break;
    case 'postgres':
      namesQuery = 'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema() ORDER BY tablename';
      break;
    case 'sqlite':
      namesQuery = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";
      break;
    default:
      throw new Error(`unsupported state database ${JSON.stringify(driver)}`);
  }
  // orm__row_lock is the ORM's row lock table, which the SQLite client creates outside a transaction before its first transaction on the connection
  // (docs/usage.md). That table is a trace of the client opening its first transaction, not a database state changed by the test, so it is not
  // included in the state.
  const tables = (await db.query(namesQuery)).rows.map(row => {
    const name = row[0];
    return name instanceof Uint8Array ? Buffer.from(name).toString('utf8') : String(name);
  }).filter(name => name !== 'orm__row_lock');
  if (tables.length === 0) throw new Error('state database has no tables');
  const hash = createHash('sha256');
  for (const table of tables) {
    const quoted = driver === 'mysql' ? `\`${table.replaceAll('`', '``')}\`` : `"${table.replaceAll('"', '""')}"`;
    let rows;
    try {
      rows = await db.query(`SELECT * FROM ${quoted}`);
    } catch (error) {
      throw new Error(`read state table ${table}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    // For each row, the hashes of the bytes encoding each value with its type are collected and sorted, producing a digest that does not depend on row order.
    const digests: Buffer[] = [];
    for (const row of rows.rows) {
      let encoded: Buffer;
      try {
        encoded = Buffer.concat(row.map(stateValue));
      } catch (error) {
        throw new Error(`read state table ${table}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      digests.push(createHash('sha256').update(encoded).digest());
    }
    digests.sort(byteOrder);
    hash.update(JSON.stringify([table, rows.columns, digests.length]));
    for (const digest of digests) hash.update(digest);
  }
  const counters = await readCounters(db, driver);
  for (const key of [...counters.keys()].sort((a, b) => byteOrder(Buffer.from(a), Buffer.from(b)))) {
    const value = counters.get(key);
    if (value !== undefined) hash.update(`counter:${key}:${value.value}:${value.called}\n`);
  }
  return hash.digest('hex');
}
