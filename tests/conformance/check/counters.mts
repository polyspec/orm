// The auto-increment counters of a database, which the state digest holds (state.mts), so that a counter a test advanced
// changes the state.
import { text, type StateDatabase } from './database.mts';

/** One counter; owner is the table that owns a PostgreSQL sequence (pg_depend), empty when no table owns it. */
export type CounterValue = { value: bigint; called: boolean; owner: string };


const mysqlAutoOption = /(?:^|\s)AUTO_INCREMENT=([0-9]+)(?:\s|$)/;


// integer reads an integer value of a row.
function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  return BigInt(text(value));
}

/** quoteIdentifier quotes a PostgreSQL or SQLite identifier. */
const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** readCounters reads the counters of the database: sqlite_sequence, MySQL AUTO_INCREMENT or PostgreSQL sequences. */
export async function readCounters(db: StateDatabase, driver: string): Promise<Map<string, CounterValue>> {
  const values = new Map<string, CounterValue>();
  switch (driver) {
    case 'sqlite': {
      const exists = await db.query("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence')");
      if (integer(exists.rows[0]?.[0]) === 0n) return values;
      for (const [name, seq] of (await db.query('SELECT name, seq FROM sqlite_sequence ORDER BY name')).rows) {
        values.set(text(name), { value: integer(seq), called: true, owner: '' });
      }
      return values;
    }
    case 'mysql': {
      const tables = (await db.query("SELECT DISTINCT c.table_name FROM information_schema.columns c WHERE c.table_schema = DATABASE() AND c.extra LIKE '%auto_increment%' ORDER BY c.table_name"))
        .rows.map(row => text(row[0]));
      for (const name of tables) {
        const shown = (await db.query(`SHOW CREATE TABLE \`${name.replaceAll('`', '``')}\``)).rows[0] ?? [];
        const returned = text(shown[0]);
        if (returned !== name) throw new Error(`SHOW CREATE TABLE returned ${JSON.stringify(returned)} for ${JSON.stringify(name)}`);
        const found = mysqlAutoOption.exec(text(shown[1]));
        values.set(name, { value: found?.[1] === undefined ? 1n : BigInt(found[1]), called: true, owner: '' });
      }
      return values;
    }
    case 'postgres': {
      // The owning table comes from pg_depend: a serial column's sequence depends on its table with deptype 'a', an
      // identity column's with 'i'. The sequence name cannot tell, because PostgreSQL truncates it to 63 bytes.
      const sequences = (await db.query(`SELECT s.schemaname, s.sequencename, COALESCE(t.relname, '')
        FROM pg_catalog.pg_sequences s
        JOIN pg_catalog.pg_namespace n ON n.nspname = s.schemaname
        JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = s.sequencename
        LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
          AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i')
        LEFT JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
        WHERE s.schemaname = current_schema() ORDER BY s.sequencename`)).rows.map(row => row.map(text));
      for (const [schema = '', name = '', owner = ''] of sequences) {
        const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
        let row: unknown[];
        try {
          row = (await db.query(`SELECT last_value, is_called FROM ${qualified}`)).rows[0] ?? [];
        } catch (error) {
          throw new Error(`read PostgreSQL sequence ${qualified}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        values.set(qualified, { value: integer(row[0]), called: text(row[1]) === 't', owner });
      }
      return values;
    }
    default:
      throw new Error(`unsupported counter database ${JSON.stringify(driver)}`);
  }
}
