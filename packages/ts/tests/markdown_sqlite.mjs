// A direct connection to a corpus: one session of its flowmark server, through which a test states SQL in SQLite's dialect as it
// does on a SQLite file (docs/spec/dialects.md DIA-185). It has the methods of a node:sqlite database that dbspec calls, answered
// asynchronously, and the query and close of a native session of the recipe runners.
import { parseDsn } from '../dist/driver.js';
import { openMarkdown } from '../dist/markdown.js';

const ignore = () => {};

/** Opens one session of the corpus of the markdown DSN dsn. */
export async function markdownSqlite(dsn) {
  const parsed = parseDsn(dsn);
  if (parsed.driver !== 'markdown') throw new Error(`${dsn} is no markdown DSN`);
  const pool = openMarkdown(parsed.markdown, { size: 1, idleSize: 1, lifetimeMs: 0 });
  let session;
  try {
    session = await pool.reserve();
  } catch (error) {
    await pool.close();
    throw error;
  }
  const run = (sql, params) => session.execute(sql, params, undefined, ignore);
  const rowObjects = result => result.rows.map(row => Object.fromEntries(result.columns.map((column, i) => [column.name, row[i]])));
  return {
    async exec(sql) { await run(sql, []); },
    prepare(sql) {
      let arrays = false;
      return {
        setReturnArrays(enabled) { arrays = enabled; },
        async all(...params) {
          const result = await run(sql, params);
          return arrays ? result.rows : rowObjects(result);
        },
        async run(...params) {
          const result = await run(sql, params);
          return { changes: result.affected, lastInsertRowid: result.insertId };
        },
      };
    },
    async query(sql) { return rowObjects(await run(sql, [])); },
    async close() {
      session.release(false);
      await pool.close();
    },
  };
}
