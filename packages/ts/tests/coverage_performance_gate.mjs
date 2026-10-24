// Measures the TypeScript client's hot-path reads against the same SQL through mysql2.
// No fixed reference is recorded for TypeScript yet, so the measurement is diagnostic only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Author, connect } from '../dist/index.js';
import { runCases } from './coverage_case.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const WARMUP = 100;
const PAIRS = 1000;

function requiredDsn() {
  const dsn = process.env.ORM_BENCH_MYSQL_DSN;
  if (!dsn) throw new Error('ORM_BENCH_MYSQL_DSN is required; run this case with the seeded MySQL bench database');
  const uri = new URL(dsn);
  if (uri.protocol !== 'mysql:') throw new Error(`ORM_BENCH_MYSQL_DSN must use mysql:, got ${uri.protocol}`);
  return uri;
}

function mysqlConfig(uri) {
  return {
    host: uri.hostname || undefined,
    port: uri.port ? Number(uri.port) : undefined,
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.slice(1)),
    socketPath: uri.searchParams.get('socket') ?? undefined,
  };
}

function median(values) {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

async function measure(name, client, native, expectedRows) {
  const clientResult = await client();
  const nativeResult = await native();
  assert.deepEqual(clientResult, nativeResult, `${name}: client and native rows`);
  assert.equal(clientResult.length, expectedRows, `${name}: row count`);

  for (let i = 0; i < WARMUP; i++) {
    await native();
    await client();
  }
  const nativeNs = [];
  const clientNs = [];
  const ratios = [];
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  for (let i = 0; i < PAIRS; i++) {
    const run = async (fn) => {
      const started = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - started);
    };
    const nFirst = (i & 1) === 0;
    const n = nFirst ? await run(native) : 0;
    const c = await run(client);
    const nMeasured = nFirst ? n : await run(native);
    nativeNs.push(nMeasured);
    clientNs.push(c);
    ratios.push(c / nMeasured);
  }
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const toMs = (time) => Number(time) / 1e6;
  const nativeP50 = median(nativeNs);
  const clientP50 = median(clientNs);
  const ratio = median(ratios);
  const machine = `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? 'unknown CPU'}`;
  process.stderr.write(
    `PERF hot_path_gate typescript ${name}: native p50=${toMs(nativeP50).toFixed(1)}µs ` +
    `client p50=${toMs(clientP50).toFixed(1)}µs ratio=${ratio.toFixed(2)} ` +
    `samples=${PAIRS} cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms ` +
    `wall=${wallMs.toFixed(1)}ms machine=${machine} reference=not-recorded\n`,
  );
}

async function hotPathGate() {
  const uri = requiredDsn();
  const dsn = uri.href;
  const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
  const nativeConnection = await require('mysql2/promise').createConnection(mysqlConfig(uri));
  try {
    const pk = () => new Author().connect(db).seq(42).addColumnSeq().addColumnName().limit(0, 1);
    const list = () => new Author().connect(db).serviceSeq(7).andIsClose(false)
      .orderBySeqDesc().limit(0, 100).addColumnSeq().addColumnName();
    const nativeFor = async (query) => {
      const { sql, binds } = await query.getQuery();
      return async () => {
        const [rows] = await nativeConnection.execute(sql, binds);
        return rows.map((row) => {
          const [seq, name] = Object.values(row);
          return [Number(seq), name];
        });
      };
    };
    const clientRows = async (query) => {
      const rows = await query.gets();
      return [...rows].map((row) => [row.getSeq(), row.getName()]);
    };
    const pkQuery = pk();
    await measure('pk', () => clientRows(pk()), await nativeFor(pkQuery), 1);
    const listQuery = list();
    await measure('list100', () => clientRows(list()), await nativeFor(listQuery), 100);
  } finally {
    await nativeConnection.end();
    await db.close();
  }
}

await runCases('coverage_performance_gate.mjs', { hot_path_gate: hotPathGate }, 300_000);
