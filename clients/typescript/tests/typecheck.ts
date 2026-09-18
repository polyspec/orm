// Type checks only (tsc): valid chains compile, and invalid chain names and
// values are rejected. Each @ts-expect-error fails the check when its line
// compiles.
import { Battle, Db, ServiceMember, User, orm } from '../src/index.js';

export async function valid(db: Db): Promise<void> {
  const rows = await new Battle().connect(db)
    .serviceSeq(7).andIsClose(false).or().readCount(6)
    .and(q => q.isDisplay(false).or(q => q.isClose(true).andGtReadCount(500)))
    .andNeReadCount([6, 106])
    .andUuid(null)
    .andBetweenReadCount([100, 200])
    .andLkName('attle')
    .andGtStartDt(orm.daysAgo(7))
    .andEqStartDt(orm.dayOfWeek(), 2)
    .andStartDt(new Date())
    .orderBySeqAsc().limit(0, 3).gets();
  for (const row of rows) {
    const seq: number = row.getSeq();
    const name: string = row.getName();
    const cover: string | null = row.getCoverUrl();
    void seq; void name; void cover;
  }
  const one: Battle | null = await new Battle().connect(db).getBySeq(42);
  const count: number = await new Battle().connect(db).getCountByServiceSeq(7);
  void one; void count;
  const member = new ServiceMember();
  await new Battle().connect(db).joinServiceMemberSeqWithSeq(member).andSuccessCountLtSeq(member).getCount();
  await new User().connect(db).seq(new Battle().addColumnUserSeq().serviceSeq(7)).gets();
  await new Battle().connect(db).setName('n').setPrice(1.5).setStartDt('2026-01-01 00:00:00').create();
  await db.transaction(async () => { await new User().name('x').forUpdate().gets(); }, { isolation: 'read_committed', retry: 0 });
}

export async function invalid(db: Db): Promise<void> {
  const b = new Battle().connect(db);
  // @ts-expect-error an unknown column is not a chain name
  b.notAColumn(1);
  // @ts-expect-error an unknown column is not a getsBy name
  await b.getsByNotAColumn(1);
  // @ts-expect-error an unknown column is not an orderBy name
  b.orderByNotAColumnAsc();
  // @ts-expect-error a string is not an integer column value
  b.serviceSeq('7');
  // @ts-expect-error null is not a value of a NOT NULL column
  b.serviceSeq(null);
  // @ts-expect-error between takes a pair
  b.andBetweenReadCount(1);
  // @ts-expect-error like takes a string
  b.andLkName(1);
  // @ts-expect-error a boolean column takes a boolean
  b.andIsClose('false');
  // @ts-expect-error a string column is not a function column
  b.andName(orm.year(), 2026);
  // @ts-expect-error a join takes a model
  b.joinServiceMemberSeqWithSeq(1);
  // @ts-expect-error setters check the column type
  b.setReadCount('1');
  // @ts-expect-error transaction options are checked
  await db.transaction(async () => undefined, { retries: 1 });
}
