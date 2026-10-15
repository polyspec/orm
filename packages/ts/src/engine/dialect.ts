// Database-specific SQL pieces (docs/dialects.md). The planner never writes a
// quote or a placeholder itself.

/** Column types each column function accepts. */
export const columnFunctionTypes: Readonly<Record<string, readonly string[]>> = {
  day_of_week: ['date', 'datetime'],
  year: ['date', 'datetime'],
  month: ['date', 'datetime'],
  date: ['date', 'datetime'],
};

/** Function arguments of each column function, not counting the compared value. */
export const columnFunctionArity: Readonly<Record<string, number>> = {
  day_of_week: 0, year: 0, month: 0, date: 0,
};

/** Interval unit of each relative value function. */
export const valueFunctionUnits: Readonly<Record<string, string>> = {
  seconds_ago: 'second', minutes_ago: 'minute', hours_ago: 'hour', days_ago: 'day', months_ago: 'month',
  seconds_later: 'second', minutes_later: 'minute', hours_later: 'hour', days_later: 'day', months_later: 'month',
};

export function isValueFunction(name: string): boolean {
  return Object.hasOwn(valueFunctionUnits, name) || name === 'now' || name === 'today';
}

export interface Dialect {
  readonly name: 'mysql' | 'postgres' | 'sqlite';
  quote(ident: string): string;
  /** Placeholder for the n-th (1-based) bind. */
  placeholder(n: number): string;
  like(col: string, ph: string): string;
  limit(offset: number, count: number): string;
  forceIndex(name: string): string;
  insertReturningId: boolean;
  upsert(conflict: readonly string[], assigns: string): string;
  /** Wraps the SQL-side read stages of a codec. */
  readExpr(col: string, stages: readonly string[]): string;
  /** Wraps a bound value with the SQL-side write stages. */
  writeExpr(ph: string, stages: readonly string[]): string;
  /** column에 쓰는 database clock이며 precision은 column의 소수 자리다. */
  now(precision: number): string;
  /** On write, the codec stage runs in SQL; every other stage runs in the executor. */
  handlesStage(stage: string): boolean;
  /**
   * On read, the codec stage is decoded in SQL (MySQL: ip). No dialect decodes hex in SQL:
   * UNHEX takes odd-length text and yields NULL for white space, so the executor decodes
   * hex exactly (docs/codec.md).
   */
  decodesStage(stage: string): boolean;
  /** The database has no sub-second clock; the executor binds the time. */
  hostNow: boolean;
  /** A row lock suffix; undefined when the mode is unknown. */
  rowLock(mode: string): string | undefined;
  columnFunction(name: string, col: string, arg: (i: number) => string): string | undefined;
  valueFunction(name: string, arg: () => string, now: () => string): string | undefined;
  containsBinary(col: string, value: (transform: string) => string): string;
  tupleIn(cols: readonly string[], rows: readonly (readonly string[])[], negate: boolean): string;
  random(): string;
  /** The clause that sorts NULL before every value ascending and after every value descending; PostgreSQL alone needs it. */
  nullsOrder(desc: boolean): string;
  /** table의 identity column을 가장 큰 key 다음 값에서 다시 시작하는 statement다. 빈 table이면 다음 key는 1이다. */
  restartIdentity(table: string, column: string): string;
}

function quoteWith(q: string, ident: string): string {
  return ident.split('.').map(part => q + part.replaceAll(q, q + q) + q).join('.');
}

/** text를 SQL 문자열 literal로 quote한다. */
function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function lockSuffix(mode: string): string | undefined {
  switch (mode) {
    case 'update': return ' FOR UPDATE';
    case 'share': return ' FOR SHARE';
    case 'update_nowait': return ' FOR UPDATE NOWAIT';
    case 'share_nowait': return ' FOR SHARE NOWAIT';
  }
  return undefined;
}

function tupleIn(cols: readonly string[], rows: readonly (readonly string[])[], negate: boolean, values: boolean): string {
  let list = rows.map(row => `(${row.join(', ')})`).join(', ');
  if (values) list = `VALUES ${list}`;
  return `(${cols.join(', ')})${negate ? ' NOT IN ' : ' IN '}(${list})`;
}

function conflictUpsert(conflict: readonly string[], assigns: string): string {
  return ` ON CONFLICT (${conflict.map(c => quoteWith('"', c)).join(', ')}) DO UPDATE SET ${assigns}`;
}

/**
 * 26 nested REPLACE calls, one for each of A to Z with its lower case: MySQL LIKE under utf8mb4_0900_bin then
 * folds the ASCII letters only, as PostgreSQL ILIKE under "C" and SQLite LIKE do.
 */
const asciiLower = (x: string): string => {
  let s = 'REPLACE('.repeat(26) + x;
  for (let c = 65; c <= 90; c++) s += `, '${String.fromCharCode(c)}', '${String.fromCharCode(c + 32)}')`;
  return s;
};

/** AES is host-side so the row key version selects the key; hex and ip are SQL-side. */
const mysql: Dialect = {
  name: 'mysql',
  quote: ident => quoteWith('`', ident),
  placeholder: () => '?',
  like: (col, ph) => `${asciiLower(col)} LIKE ${asciiLower(ph)}`,
  limit: (offset, count) => ` LIMIT ${offset}, ${count}`,
  forceIndex: name => ` FORCE INDEX (${quoteWith('`', name)})`,
  insertReturningId: false,
  upsert: (_, assigns) => ` ON DUPLICATE KEY UPDATE ${assigns}`,
  readExpr(col, stages) {
    let expr = col;
    for (let i = stages.length - 1; i >= 0; i--) {
      if (stages[i] === 'ip') expr = `INET6_NTOA(${expr})`;
    }
    return expr;
  },
  writeExpr(ph, stages) {
    let expr = ph;
    for (const s of stages) {
      if (s === 'hex') expr = `HEX(${expr})`;
      else if (s === 'ip') expr = `INET6_ATON(${expr})`;
    }
    return expr;
  },
  now: precision => precision > 0 ? `CURRENT_TIMESTAMP(${precision})` : 'CURRENT_TIMESTAMP',
  handlesStage: s => s === 'hex' || s === 'ip',
  decodesStage: s => s === 'ip',
  hostNow: false,
  rowLock: lockSuffix,
  columnFunction(name, col) {
    switch (name) {
      case 'day_of_week': return `DAYOFWEEK(${col})`;
      case 'year': return `YEAR(${col})`;
      case 'month': return `MONTH(${col})`;
      case 'date': return `DATE(${col})`;
    }
    return undefined;
  },
  valueFunction(name, arg) {
    if (name === 'now') return 'NOW(6)';
    if (name === 'today') return 'CURDATE()';
    const unit = valueFunctionUnits[name];
    if (unit === undefined) return undefined;
    return `${name.endsWith('_later') ? 'DATE_ADD' : 'DATE_SUB'}(NOW(6), INTERVAL ${arg()} ${unit.toUpperCase()})`;
  },
  containsBinary: (col, value) => `${col} LIKE BINARY ${value('like_contains')}`,
  tupleIn: (cols, rows, negate) => tupleIn(cols, rows, negate, false),
  random: () => 'RAND()',
  nullsOrder: () => '',
  // InnoDB는 AUTO_INCREMENT를 column의 가장 큰 값 이하로 정하면 가장 큰 값에 1을 더한 값으로 정하므로 1은
  // 언제나 가장 큰 key 다음이다. DDL이므로 열린 transaction을 commit한다.
  restartIdentity: table => `ALTER TABLE ${quoteWith('`', table)} AUTO_INCREMENT = 1`,
};

/** Every codec stage is host-side: an ip value is stored as bytes in a bytea column. */
const postgres: Dialect = {
  name: 'postgres',
  quote: ident => quoteWith('"', ident),
  placeholder: n => `$${n}`,
  like: (col, ph) => `${col} ILIKE ${ph}`,
  limit: (offset, count) => ` LIMIT ${count} OFFSET ${offset}`,
  forceIndex: () => '',
  insertReturningId: true,
  upsert: conflictUpsert,
  readExpr: col => col,
  writeExpr: ph => ph,
  now: () => 'CURRENT_TIMESTAMP',
  handlesStage: () => false,
  decodesStage: () => false,
  hostNow: false,
  rowLock: lockSuffix,
  columnFunction(name, col) {
    switch (name) {
      case 'day_of_week': return `(EXTRACT(DOW FROM ${col})::int + 1)`;
      case 'year': return `EXTRACT(YEAR FROM ${col})::int`;
      case 'month': return `EXTRACT(MONTH FROM ${col})::int`;
      case 'date': return `CAST(${col} AS date)`;
    }
    return undefined;
  },
  valueFunction(name, arg) {
    if (name === 'now') return 'now()';
    if (name === 'today') return 'CURRENT_DATE';
    const unit = valueFunctionUnits[name];
    if (unit === undefined) return undefined;
    const fields: Readonly<Record<string, string>> = { second: 'secs', minute: 'mins', hour: 'hours', day: 'days', month: 'months' };
    const field = fields[unit];
    if (field === undefined) throw new Error(`the interval unit ${unit} has no make_interval field`);
    const cast = field === 'secs' ? 'double precision' : 'integer';
    return `(now()${name.endsWith('_later') ? ' + ' : ' - '}make_interval(${field} => CAST(${arg()} AS ${cast})))`;
  },
  containsBinary: (col, value) => `${col} LIKE ${value('like_contains')}`,
  tupleIn: (cols, rows, negate) => tupleIn(cols, rows, negate, false),
  random: () => 'random()',
  nullsOrder: desc => (desc ? ' NULLS LAST' : ' NULLS FIRST'),
  // identity sequence를 가장 큰 key에 1을 더한 값으로 정하고 is_called를 false로 두어 다음 nextval이 그 값을
  // 돌려주게 한다. pg_get_serial_sequence의 첫 인자는 identifier로 읽히므로 quote한 table 이름이고, 둘째
  // 인자는 column 이름 그대로다.
  restartIdentity(table, column) {
    const q = quoteWith('"', column);
    return `SELECT setval(pg_get_serial_sequence(${literal(quoteWith('"', table))}, ${literal(column)}), COALESCE(MAX(${q}), 0) + 1, false) FROM ${quoteWith('"', table)}`;
  },
};

/** Every codec stage is host-side. */
const sqlite: Dialect = {
  name: 'sqlite',
  quote(ident) {
    return quoteWith('"', ident.split('.').join('__'));
  },
  placeholder: () => '?',
  like: (col, ph) => `${col} LIKE ${ph} ESCAPE '\\'`,
  limit: (offset, count) => ` LIMIT ${count} OFFSET ${offset}`,
  forceIndex: name => ` INDEXED BY ${quoteWith('"', name)}`,
  insertReturningId: true,
  upsert: conflictUpsert,
  readExpr: col => col,
  writeExpr: ph => ph,
  now: () => 'CURRENT_TIMESTAMP',
  handlesStage: () => false,
  decodesStage: () => false,
  hostNow: true,
  // The executor takes an ORM-owned lock row; the SQL suffix stays empty.
  rowLock: mode => lockSuffix(mode) === undefined ? undefined : '',
  columnFunction(name, col) {
    switch (name) {
      case 'day_of_week': return `(CAST(strftime('%w', ${col}) AS INTEGER) + 1)`;
      case 'year': return `CAST(strftime('%Y', ${col}) AS INTEGER)`;
      case 'month': return `CAST(strftime('%m', ${col}) AS INTEGER)`;
      case 'date': return `date(${col})`;
    }
    return undefined;
  },
  // The executor clock is bound; `floor` keeps the last valid day of the month.
  valueFunction(name, arg, now) {
    if (name === 'now') return now();
    if (name === 'today') return `date(${now()})`;
    const unit = valueFunctionUnits[name];
    if (unit === undefined) return undefined;
    const sign = name.endsWith('_later') ? "'+'" : "'-'";
    // datetime returns whole seconds: append the six fraction digits of a
    // second clock slot, which equals the first in one statement.
    const clock = now();
    const modifier = `${sign} || CAST(${arg()} AS TEXT) || ' ${unit}s'${unit === 'month' ? ", 'floor'" : ''}`;
    return `(datetime(${clock}, ${modifier}) || substr(${now()}, 20))`;
  },
  // SQLite LIKE ignores ASCII case.
  containsBinary: (col, value) => `instr(${col}, ${value('')}) > 0`,
  tupleIn: (cols, rows, negate) => tupleIn(cols, rows, negate, true),
  random: () => 'random()',
  nullsOrder: () => '',
  // AUTOINCREMENT table의 다음 key는 sqlite_sequence의 seq에 1을 더한 값이므로 seq를 가장 큰 key로 정한다.
  // table이 아직 행을 받은 적이 없어 sqlite_sequence에 행이 없으면 다음 key는 이미 가장 큰 key 다음이다.
  restartIdentity: (table, column) => `UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(${quoteWith('"', column)}), 0) FROM ${quoteWith('"', table)}) WHERE name = ${literal(table)}`,
};

export function dialectOf(name: string): Dialect | undefined {
  switch (name) {
    case 'mysql': return mysql;
    case 'postgres': return postgres;
    case 'sqlite': return sqlite;
  }
  return undefined;
}
