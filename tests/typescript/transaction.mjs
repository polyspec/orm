import { Db, OrmError } from '../../clients/typescript/dist/index.js';

function connection() {
  const state = { begins: 0, commits: 0, rollbacks: 0 };
  const root = {
    name: 'sqlite',
    async execute() { return { rows: [], columns: [], affected: 0, insertId: null }; },
    async stream() { return { count: 0, exhausted: true }; },
    async begin() {
      state.begins++;
      return {
        name: 'sqlite',
        async execute() { return { rows: [], columns: [], affected: 0, insertId: null }; },
        async stream() { return { count: 0, exhausted: true }; },
        async begin() { throw new Error('nested transaction is not used by this test'); },
        async close() {},
        async commit() { state.commits++; },
        async rollback() { state.rollbacks++; },
        async savepoint(name) { if (name.includes(';')) throw new OrmError('CONFIG', 'invalid savepoint'); },
        async rollbackTo() {},
        async releaseSavepoint() {},
      };
    },
    async close() {},
  };
  return { root, state };
}

const compiler = { async compile() { throw new Error('compiler is not used'); }, async metadata() { throw new Error('compiler is not used'); } };

{
  const { root, state } = connection();
  const db = new Db(root, { schemaHash: 'test', compiler });
  let calls = 0;
  try {
    await db.transaction(async () => {
      calls++;
      throw new OrmError('DEADLOCK', 'injected deadlock');
    });
    throw new Error('default transaction unexpectedly retried');
  } catch (error) {
    if (!(error instanceof OrmError) || error.code !== 'DEADLOCK') throw error;
  }
  if (calls !== 1 || state.begins !== 1 || state.rollbacks !== 1 || state.commits !== 0) {
    throw new Error(`default transaction retry state differs: ${JSON.stringify({ calls, ...state })}`);
  }
}

{
  const { root, state } = connection();
  const db = new Db(root, { schemaHash: 'test', compiler });
  let calls = 0;
  const result = await db.transaction(async () => {
    calls++;
    if (calls === 1) throw new OrmError('DEADLOCK', 'injected deadlock');
    return 'committed';
  }, { retryDeadlocks: true, maxAttempts: 2 });
  if (result !== 'committed' || calls !== 2 || state.begins !== 2 || state.rollbacks !== 1 || state.commits !== 1) {
    throw new Error(`explicit transaction retry state differs: ${JSON.stringify({ result, calls, ...state })}`);
  }
}

{
  const { root } = connection();
  const db = new Db(root, { schemaHash: 'test', compiler });
  await db.transaction(async tx => {
    await tx.savepoint('probe');
    await tx.rollbackTo('probe');
    await tx.releaseSavepoint('probe');
    try { await tx.savepoint('probe; DROP TABLE probe'); throw new Error('injection accepted'); }
    catch (error) { if (!(error instanceof OrmError) || error.code !== 'CONFIG') throw error; }
  });
}

{
  const { root } = connection();
  const db = new Db(root, { schemaHash: 'test', compiler });
  try {
    await db.transaction(async () => {}, { timeoutMs: 1 });
    throw new Error('SQLite transaction timeout was accepted');
  } catch (error) {
    if (!(error instanceof OrmError) || error.code !== 'CAPABILITY_UNSUPPORTED') throw error;
  }
}

console.log('typescript transaction retry policy passed');
