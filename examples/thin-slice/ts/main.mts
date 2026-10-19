// Thin-slice demo (TypeScript): one statement in every client language, one JSON.
// stdout: the result as JSON. stderr: p50 of the generated client and of the
// same SQL through mysql2 directly.
//
//   node examples/thin-slice/ts/main.mts
import { createConnection } from 'mysql2/promise';
// The built client of this checkout, as the TypeScript tests import it (packages/ts/tests/*.mjs).
import { Author, connect } from '../../../packages/ts/dist/index.js';

const ITERATIONS = 500;
const AES_KEY = 'bench-salt';

/** dsn returns the seeded bench database that ORM_BENCH_MYSQL_DSN names; without it the program ends before any connection. */
function dsn(): string {
  const value = process.env.ORM_BENCH_MYSQL_DSN;
  if (value === undefined || value === '') {
    console.error('ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make orm-check or make run-databases TARGETS=<target>, which create the bench database of the run');
    process.exit(1);
  }
  return value;
}

/** p50 runs f ITERATIONS times and returns the median elapsed time in microseconds. */
async function p50(f: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await f();
    samples.push(Math.round((performance.now() - start) * 1000));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

async function main(): Promise<void> {
  const target = dsn();
  const url = new URL(target);
  let lastSql = '';
  let lastArgs: unknown[] = [];
  const db = await connect(target, { aesKey: AES_KEY, blindIndexKey: 'bench-blind-index' });
  try {
    db.subscribe(event => {
      lastSql = event.sql;
      // A secret bind is reported as the marker $SECRET; the native statement needs the key it stands for.
      lastArgs = event.binds.map(value => (value === '$SECRET' ? AES_KEY : value));
    });
    const now = new Date(Date.UTC(2026, 8, 11, 0, 0, 0));
    const query = () => new Author().connect(db)
      .serviceSeq(7)
      .andIsClose(false)
      .and(q => { q.isDisplay(true).or(q => q.isDisplay(false).andLtDisplayStartDt(now)); })
      .andSeq([6, 106, 206, 306, 406])
      .orderBySeqDesc()
      .limit(0, 3)
      .gets();

    const rows = await query();
    const out = [...rows].map(r => ({ is_display: r.getIsDisplay(), like_count: r.getLikeCount(), name: r.getName(), seq: r.getSeq() }));
    console.log(JSON.stringify(out));

    const client = await p50(async () => { await query(); });
    const raw = await createConnection({
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      ...(url.searchParams.get('socket') !== null ? { socketPath: url.searchParams.get('socket') ?? undefined } : { host: url.hostname, port: url.port ? Number(url.port) : undefined }),
    });
    try {
      const native = await p50(async () => { await raw.execute(lastSql, lastArgs); });
      console.error(`ts: client p50 ${client}µs, native p50 ${native}µs (${ITERATIONS} iterations)`);
    } finally {
      await raw.end();
    }
  } finally {
    await db.close();
  }
}

await main();
