// The refusals of INT-150a and INT-150b for one database, which statement-runner.mjs runs; the recipe statement_runner holds the rest.
import { Db } from '../dist/index.js';

/**
 * A frame refuses a statement that is not text, and any statement after its transaction ended, with CONFIG, and sends neither
 * (INT-150).
 * @param {string} driver
 * @param {string} dsn
 * @param {(condition: boolean, message: string) => void} check
 */
export async function runStatementRunnerRefusals(driver, dsn, check) {
  const db = await Db.connect(dsn);
  /** @param {() => Promise<unknown>} call */
  const codeOf = call => call().then(() => null, error => /** @type {{ code: string }} */ (error).code);
  try {
    const notText = await codeOf(() => db.utils().run(async frame => frame.run('utility', [], /** @type {string} */ (/** @type {unknown} */ (123)))));
    check(notText === 'CONFIG', `${driver}: a statement that is not text failed with ${notText}, want CONFIG`);
    /** @type {{ run(kind: string, tables: string[], sql: string): Promise<unknown> } | undefined} */
    let kept;
    await db.utils().run(async frame => { kept = /** @type {never} */ (frame); });
    const frame = /** @type {{ run(kind: string, tables: string[], sql: string): Promise<unknown> }} */ (kept);
    let statements = 0;
    const stop = db.subscribe(() => { statements++; });
    const ended = await codeOf(() => frame.run('utility', [], 'SELECT 1'));
    stop();
    check(ended === 'CONFIG', `${driver}: a frame after its transaction ended failed with ${ended}, want CONFIG`);
    check(statements === 0, `${driver}: a frame after its transaction ended sent ${statements} statements, want none`);
  } finally {
    await db.close();
  }
}
