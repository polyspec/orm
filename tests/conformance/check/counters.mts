// The auto-increment counters of a bench database: a conformance run reads them before the runners, and restores those of
// the tables the vectors write after them, so that the counters that the runners advanced do not change the database
// state. A changed counter of any other table is an error.
import { text, type StateDatabase } from './database.mts';

/** One counter; owner is the table that owns a PostgreSQL sequence (pg_depend), empty when no table owns it. */
export type CounterValue = { value: bigint; called: boolean; owner: string };

/** The tables that the conformance vectors write. */
export const conformanceWriteTables = new Set(['author', 'service', 'service_member', 'soft_link', 'soft_record', 'task', 'time_cell', 'day_cell', 'clock_cell', 'upsert_cell', 'uuid_cell', 'bind_cell', 'audit_record', 'audited_note', 'audited_note_history']);

const mysqlAutoOption = /(?:^|\s)AUTO_INCREMENT=([0-9]+)(?:\s|$)/;

const sameCounter = (a: CounterValue, b: CounterValue): boolean => a.value === b.value && a.called === b.called && a.owner === b.owner;

// integer reads an integer value of a row.
function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  return BigInt(text(value));
}

/** quoteIdentifier quotes a PostgreSQL or SQLite identifier. */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

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

/**
 * restoreCounters puts back the counters that changed since `before` was read. A counter of a table that the vectors do
 * not write, a PostgreSQL sequence that no table owns, and a MySQL or PostgreSQL counter that appeared or disappeared are
 * errors.
 */
export async function restoreCounters(db: StateDatabase, driver: string, before: Map<string, CounterValue>): Promise<void> {
  const after = await readCounters(db, driver);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const name of names) {
    const old = before.get(name);
    const current = after.get(name);
    if (old !== undefined && current !== undefined && sameCounter(old, current)) continue;
    let table = name;
    if (driver === 'postgres') {
      // A sequence belongs to the table that owns it; the conformance vectors change no sequence that no table owns.
      table = (old ?? current)?.owner ?? '';
      if (table === '') throw new Error(`PostgreSQL sequence owned by no table changed: ${name}`);
    }
    if (!conformanceWriteTables.has(table)) throw new Error(`undeclared ${driver} counter changed: ${name}`);
    if (driver !== 'sqlite' && (old === undefined || current === undefined)) throw new Error(`${driver} counter appeared or disappeared: ${name}`);
    const oldValue = old?.value ?? 0n;
    console.log(`check: restore ${driver} counter ${name} from ${current?.value ?? 0n} to ${oldValue}`);
    try {
      switch (driver) {
        case 'sqlite':
          if (old !== undefined) await db.exec('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [oldValue, name]);
          else await db.exec('DELETE FROM sqlite_sequence WHERE name = ?', [name]);
          break;
        case 'mysql':
          await db.exec(`ALTER TABLE \`${name.replaceAll('`', '``')}\` AUTO_INCREMENT = ${oldValue}`);
          break;
        case 'postgres':
          await db.exec('SELECT setval($1::regclass, $2, $3)', [name, String(oldValue), old?.called ?? false]);
          break;
        default:
          throw new Error(`unsupported counter database ${JSON.stringify(driver)}`);
      }
    } catch (error) {
      throw new Error(`restore ${driver} counter ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}
