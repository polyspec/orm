import { Author, Db, GroupRow, GroupRows, OrmError } from '../dist/index.js';

const { ORM_GROUP_DATABASE: driver, ORM_GROUP_DSN: dsn } = process.env;
if (!['mysql', 'postgres', 'sqlite'].includes(driver) || !dsn) {
  throw new Error('ORM_GROUP_DATABASE and ORM_GROUP_DSN are required');
}
const db = await Db.connect(dsn, { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' });
try {
  if (db.driver !== driver) throw new Error('DSN selected the wrong database');
  const query = () => new Author().connect(db);
  const groups = await query().groupByIsClose().orderByIsCloseAsc().getsCount();
  if (!(groups instanceof GroupRows) || groups.length !== 2) throw new Error('getsCount returned partial models');
  let total = 0;
  for (const row of groups) {
    if (!(row instanceof GroupRow) || typeof row.value('is_close') !== 'boolean' || row.count < 1) {
      throw new Error('grouped boolean or count has the wrong type');
    }
    if (JSON.stringify(Object.keys(row.toArray())) !== '["is_close","row_count"]') {
      throw new Error('group row includes an unselected field');
    }
    try {
      row.value('name');
      throw new Error('unselected model column was available');
    } catch (error) {
      if (!(error instanceof OrmError) || error.code !== 'COLUMN_UNSELECTED') throw error;
    }
    total += row.count;
  }
  if (total !== await query().getCount()) throw new Error('group counts do not sum to the row count');
  const services = await query().groupByServiceSeq().getsCount();
  let serviceTotal = 0;
  for (const row of services) {
    if (typeof row.value('service_seq') !== 'number' || !Number.isSafeInteger(row.value('service_seq'))) {
      throw new Error('grouped integer changed type');
    }
    serviceTotal += row.count;
  }
  if (serviceTotal !== total) throw new Error('service group counts differ');
  const nullable = await query().groupByPrice().getsCount();
  let nullableTotal = 0;
  let sawNull = false;
  for (const row of nullable) {
    if (row.value('price') === null) sawNull = true;
    nullableTotal += row.count;
  }
  if (!sawNull || nullableTotal !== total) throw new Error('SQL NULL group value was lost');
} finally {
  await db.close();
}
console.log(`CASE group_rows_${driver} PASS`);
