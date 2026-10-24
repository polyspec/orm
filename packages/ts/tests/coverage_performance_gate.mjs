// Measures TypeScript hot-path reads against the same SQL through the native driver named by the feature DSN.
// No fixed reference is recorded for this full-row workload, so the measurement is diagnostic only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Author, connect, hostDecode } from '../dist/index.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const WARMUP = 100;
const PAIRS = 1000;

function featureItem(item) {
  const dsn = process.env.ORM_FEATURE_DSN;
  const database = process.env.ORM_FEATURE_DATABASE;
  if (!dsn || !database) throw new Error('ORM_FEATURE_DSN and ORM_FEATURE_DATABASE are required; run this case through make feature-check');
  if (dsn !== item.dsn || database !== item.driver) throw new Error('the coverage item differs from ORM_FEATURE_DSN or ORM_FEATURE_DATABASE');
  const schemes = { mysql: 'mysql:', postgres: 'postgres:', sqlite: 'sqlite:' };
  const uri = new URL(dsn);
  if (uri.protocol !== schemes[database]) throw new Error(`ORM_FEATURE_DSN scheme ${uri.protocol} does not match ${database}`);
  return { database, dsn, uri };
}

function connectionOptions(uri) {
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

async function measure(database, name, client, native, expectedRows) {
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
    `PERF hot_path_gate typescript ${database} ${name}: native p50=${toMs(nativeP50).toFixed(1)}µs ` +
    `client p50=${toMs(clientP50).toFixed(1)}µs ratio=${ratio.toFixed(2)} ` +
    `samples=${PAIRS} cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms ` +
    `wall=${wallMs.toFixed(1)}ms machine=${machine} reference=not-recorded\n`,
  );
}

async function openNative(database, uri) {
  if (database === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(decodeURIComponent(uri.pathname));
    return { query: async (sql, binds) => db.prepare(sql).all(...binds), close: () => db.close() };
  }
  if (database === 'mysql') {
    const db = await require('mysql2/promise').createConnection(connectionOptions(uri));
    return { query: async (sql, binds) => (await db.execute(sql, binds))[0], close: () => db.end() };
  }
  const { Client } = require('pg');
  const db = new Client({
    host: uri.searchParams.get('host') ?? uri.hostname,
    port: uri.port ? Number(uri.port) : undefined,
    database: decodeURIComponent(uri.pathname.slice(1)),
    user: decodeURIComponent(uri.username) || undefined,
    password: decodeURIComponent(uri.password) || undefined,
  });
  await db.connect();
  return { query: async (sql, binds) => (await db.query(sql, binds)).rows, close: () => db.end() };
}

function typedNativeRow(row) {
  const values = [
    Number(row.a__seq),
    String(row.a__name),
    row.a__created_ts === null ? null : new Date(row.a__created_ts),
    row.a__updated_ts === null ? null : new Date(row.a__updated_ts),
    Boolean(row.a__is_close),
    Boolean(row.a__is_display),
    row.a__display_start_dt === null ? null : new Date(row.a__display_start_dt),
    row.a__display_end_dt === null ? null : new Date(row.a__display_end_dt),
    Boolean(row.a__is_allday),
    Number(row.a__target_club_reader_count),
    Number(row.a__success_count),
    Number(row.a__reader_count),
    Number(row.a__read_count),
    row.a__photo_url === null ? null : String(row.a__photo_url),
    Number(row.a__user_seq),
    Number(row.a__service_seq),
    Number(row.a__service_region_seq),
    Number(row.a__service_member_seq),
    new Date(row.a__start_dt),
    new Date(row.a__end_dt),
    row.a__uuid === null ? null : String(row.a__uuid),
    Boolean(row.a__is_single_work),
    Number(row.a__like_count),
    hostDecode(row.a__aes_hex_email, ['aes', 'hex'], 'bench-salt'),
    hostDecode(row.a__aes_hex_phone, ['aes', 'hex'], 'bench-salt'),
    row.a__price === null ? null : String(row.a__price),
    Number(row.a__aes_key_version),
  ];
  if (values.length !== 27) throw new Error(`native author row has ${values.length} typed values`);
  return [values[0], values[1]];
}

export async function hotPathGate(item, expectedDatabase) {
  const { database, dsn, uri } = featureItem(item);
  if (database !== expectedDatabase) throw new Error(`coverage path expects ${expectedDatabase}, received ${database}`);
  const db = await connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
  if (db.driver !== database) throw new Error(`client opened ${db.driver}, want ${database}`);
  const nativeConnection = await openNative(database, uri);
  try {
    const pk = () => new Author().connect(db).seq(42).limit(0, 1);
    const list = () => new Author().connect(db).serviceSeq(7).andIsClose(false).orderBySeqDesc().limit(0, 100);
    const nativeFor = async (query) => {
      const { sql, binds } = await query.getQuery();
      return async () => {
        const rows = await nativeConnection.query(sql, binds);
        return rows.map(typedNativeRow);
      };
    };
    const clientRows = async (query) => {
      const rows = await query.gets();
      return [...rows].map((row) => [row.getSeq(), row.getName()]);
    };
    const pkQuery = pk();
    await measure(database, 'pk', () => clientRows(pk()), await nativeFor(pkQuery), 1);
    const listQuery = list();
    await measure(database, 'list100', () => clientRows(list()), await nativeFor(listQuery), 100);
  } finally {
    await nativeConnection.close();
    await db.close();
  }
}
