// SQLite locking: several processes commit read-then-write transactions on
// one file without transaction retries, a second connection reads while a
// write transaction is open, and a write that waits longer than busy_timeout
// returns CANCELED.
//
// Usage: node tests/typescript/sqlite-concurrency.mjs (after npm run typescript:build)
// The test starts itself as a writer process: sqlite-concurrency.mjs writer <dsn> <name> <count>
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db, OrmError, Service } from '../../clients/typescript/dist/index.js';

const schemaPath = fileURLToPath(new URL('../../schema/schema.json', import.meta.url));

/** Runs count transactions that read the service count and then insert one service. */
async function writeServices(db, name, count) {
  for (let i = 0; i < count; i++) {
    await db.transaction(async () => {
      await new Service().getCount();
      await new Service().setName(`${name}-${i}`).create();
    }, { retry: 0 });
  }
}

if (process.argv[2] === 'writer') {
  const [, , , dsn, name, count] = process.argv;
  const db = await Db.connect(dsn, schemaPath);
  try {
    await writeServices(db, name, Number(count));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally { await db.close(); }
  process.exit(0);
}

const work = await mkdtemp(join(tmpdir(), 'orm-ts-sqlite-lock-'));
const manifestJson = await readFile(schemaPath, 'utf8');
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}

/** A new SQLite file with the schema installed and its DSN. */
async function database(name) {
  const dsn = `sqlite://${join(work, `${name}.sqlite`)}`;
  const db = await Db.connect(dsn, schemaPath);
  try { await db.utils().schema().install(manifestJson); } finally { await db.close(); }
  return dsn;
}

async function count(dsn) {
  const db = await Db.connect(dsn, schemaPath);
  try { return await new Service().connect(db).getCount(); } finally { await db.close(); }
}

/** Runs one writer process and resolves with its exit code and output. */
function writerProcess(dsn, name, writes) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'writer', dsn, name, String(writes)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => resolve({ code, output }));
  });
}

const tests = {
  async writersInSeveralProcesses() {
    const dsn = await database('processes');
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => writerProcess(dsn, `p${i}`, 40)));
    results.forEach(({ code, output }, i) => check(code === 0, `writer process ${i} exited with ${code}: ${output}`));
    const n = await count(dsn);
    check(n === 240, `services: ${n}, want 240`);
  },
  async readsDuringWrite() {
    const dsn = await database('reads');
    const writer = await Db.connect(dsn, schemaPath);
    const reader = await Db.connect(dsn, schemaPath);
    try {
      await writer.transaction(async () => {
        await new Service().setName('pending').create();
        const during = await new Service().connect(reader).getCount();
        check(during === 0, `read during the write: ${during} services, want 0`);
        const readOnly = await reader.transaction(async () => new Service().getCount(), { readOnly: true, retry: 0 });
        check(readOnly === 0, `read-only transaction during the write: ${readOnly} services, want 0`);
      }, { retry: 0 });
      const after = await new Service().connect(reader).getCount();
      check(after === 1, `read after the write: ${after} services, want 1`);
    } finally {
      await writer.close();
      await reader.close();
    }
  },
  async lockWaitExpires() {
    const dsn = await database('expiry');
    const holder = await Db.connect(dsn, schemaPath);
    const waiter = await Db.connect(`${dsn}?_pragma=busy_timeout(200)`, schemaPath);
    try {
      await holder.transaction(async () => {
        await new Service().setName('holder').create();
        const started = performance.now();
        let code = 'no error';
        try { await writeServices(waiter, 'waiter', 1); } catch (error) { code = error instanceof OrmError ? error.code : String(error); }
        const waited = performance.now() - started;
        check(code === 'CANCELED', `write past the lock wait: ${code}, want CANCELED`);
        check(waited >= 200, `write returned after ${waited.toFixed(0)}ms, before the 200ms lock wait`);
      }, { retry: 0 });
    } finally {
      await holder.close();
      await waiter.close();
    }
  },
};

try {
  for (const [name, test] of Object.entries(tests)) {
    current = name;
    const before = failures;
    const started = performance.now();
    console.log(`RUN  ${name}`);
    try { await test(); } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
    console.log(`${failures === before ? 'PASS' : 'FAIL'} ${name} (${((performance.now() - started) / 1000).toFixed(2)}s)`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript sqlite concurrency: ${failures} failures`);
  process.exit(1);
}
console.log('typescript sqlite concurrency passed');
