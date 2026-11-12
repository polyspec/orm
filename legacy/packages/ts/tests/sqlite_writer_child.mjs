// One writer of the op transaction.writers of recipe.mjs: it commits count read-then-write transactions on the file of
// dsn, without retries (CFG-12).
// Usage: node packages/ts/tests/sqlite_writer_child.mjs <dsn> <name> <count>
import { Service, connect } from '../dist/index.js';

const [, , dsn, name, count] = process.argv;
const db = await connect(dsn);
try {
  for (let i = 0; i < Number(count); i++) {
    await db.transaction(async () => {
      await new Service().getCount();
      await new Service().setName(`${name}-${i}`).create();
    }, { retry: 0 });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { await db.close(); }
