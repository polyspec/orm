// CFG-2: the connection stores, reads, filters and defaults datetimes in UTC.
import { Author, Service, ServiceMember, ServiceRegion, User, connect as connectBench } from '../dist/index.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { installBench } from './bench-set.mjs';
import { withCaseDatabase } from './case-database.mjs';

async function seed(db) {
  const service = await new Service().connect(db).setName('utc-service').create();
  const user = await new User().connect(db).setName('utc-user').create();
  const region = await new ServiceRegion().connect(db).setServiceSeq(service.getSeq()).setName('utc-region').create();
  const member = await new ServiceMember().connect(db).setServiceSeq(service.getSeq()).setUserSeq(user.getSeq()).create();
  return { service, user, region, member };
}

async function checkUtcConnection(db) {
  const refs = await seed(db);
  const before = Date.now();
  const created = await new Author().connect(db)
    .setName('utc-row')
    .setUserSeq(refs.user.getSeq())
    .setServiceSeq(refs.service.getSeq())
    .setServiceRegionSeq(refs.region.getSeq())
    .setServiceMemberSeq(refs.member.getSeq())
    .setStartDt('2026-01-01 15:00:00')
    .setEndDt('2026-01-03 00:00:00')
    .create();
  const row = await new Author().connect(db).getBySeq(created.getSeq());
  if (row?.getStartDt() !== '2026-01-01 15:00:00.000000') {
    throw new Error(`start_dt ${row?.getStartDt()}`);
  }
  const createdWall = Date.parse(`${row.getCreatedTs().replace(' ', 'T').slice(0, 23)}Z`);
  if (Math.abs(createdWall - before) >= 60_000) {
    throw new Error(`created_ts ${row.getCreatedTs()} at ${new Date(before).toISOString()}`);
  }
  const author = () => new Author().connect(db);
  const equal = await author().startDt('2026-01-01 15:00:00').getCount();
  if (equal !== 1) throw new Error(`UTC equality filter returned ${equal}`);
  const fractional = await author().startDt('2026-01-01T15:00:00.0').getCount();
  if (fractional !== 1) throw new Error(`UTC fractional equality filter returned ${fractional}`);
  const inCount = await author().startDt(['2026-01-01 15:00:00', '2026-01-03 00:00:00']).getCount();
  if (inCount !== 1) throw new Error(`UTC IN filter returned ${inCount}`);
  const between = await author().betweenStartDt(['2026-01-01 15:00:00', '2026-01-01 15:00:00.5']).getCount();
  if (between !== 1) throw new Error(`UTC between filter returned ${between}`);
}

// Requirements: CFG-2, DIA-57, DSL-141.
for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  for (const zone of ['', 'UTC', '+00:00']) {
    const suffix = zone === '' ? 'default' : zone === '+00:00' ? 'offset' : 'utc';
    caseTest(`connection/utc-runtime/${dialect}/${suffix}`, DATABASE, async ({ step }) => {
      await withCaseDatabase(dialect, step, async database => {
        const separator = database.dsn.includes('?') ? '&' : '?';
        const dsn = zone === '' ? database.dsn : `${database.dsn}${separator}timezone=${encodeURIComponent(zone)}`;
        const db = await connectBench(dsn, { aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key' });
        try {
          await installBench(db);
          await checkUtcConnection(db);
        } finally {
          await db.close();
        }
      });
    });
  }
}
