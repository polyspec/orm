// Database-specific SQL pieces (docs/spec/dialects.md). The planner never writes a
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

/**
 * The largest interval of each unit that stays inside orm's range, 0001-01-01 to 9999-12-31 (3652059 days): a relative
 * time function whose interval exceeds it is NULL, so no database computes it and PostgreSQL never fails with interval
 * out of range (postgres.relative.interval_out_of_range).
 */
const intervalBounds: Readonly<Record<string, string>> = { second: '315537897600', minute: '5258964960', hour: '87649416', day: '3652059', month: '119988' };

/**
 * The interval argument of a relative time function, NULL past its bound. The guard sits inside the argument, not
 * around the function, so a database that folds constants never evaluates an out-of-range interval.
 */
function guardInterval(unit: string, operandCast: string, arg: () => string): string {
  // A typed placeholder needs its cast on both sides: PostgreSQL infers an uncast THEN placeholder as text.
  const cast = (placeholder: string): string => (operandCast === '' ? placeholder : `CAST(${placeholder} AS ${operandCast})`);
  const operand = cast(arg());
  const bound = intervalBounds[unit];
  return `CASE WHEN ${operand} BETWEEN -${bound} AND ${bound} THEN ${cast(arg())} END`;
}

/**
 * A relative time value, NULL outside 0001-01-01 00:00:00 to 9999-12-31 23:59:59.999999: past the range MySQL and
 * SQLite give NULL, below it they give the year 0000 (mysql.relative.out_of_range_null,
 * sqlite.relative.out_of_range_null), and PostgreSQL gives the year 10000 or later.
 */
function guardResult(value: () => string): string {
  return `CASE WHEN ${value()} BETWEEN '0001-01-01 00:00:00' AND '9999-12-31 23:59:59.999999' THEN ${value()} END`;
}

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
  /**
   * A time(p) column read as its value text `HH:MM:SS` with exactly p fraction digits, which the database writes
   * (MySQL CAST AS CHAR, PostgreSQL to_char); SQLite stores that text.
   */
  readTime(col: string, precision: number): string;
  /** A time(p) value bound as its text: PostgreSQL casts the text to time. */
  writeTime(ph: string): string;
  /** A uuid column read as its text: PostgreSQL casts the uuid to text. */
  readUuid(col: string): string;
  /** A uuid value bound as its text: PostgreSQL casts the text to uuid. */
  writeUuid(ph: string): string;
  /** The database clock written to a column; the precision is the column's fractional digits. */
  now(precision: number): string;
  /** On write, the codec stage runs in SQL; every other stage runs in the executor. */
  handlesStage(stage: string): boolean;
  /**
   * On read, the codec stage is decoded in SQL (MySQL: ip). No dialect decodes hex in SQL:
   * UNHEX takes odd-length text and yields NULL for white space, so the executor decodes
   * hex exactly (docs/spec/codec.md).
   */
  decodesStage(stage: string): boolean;
  /**
   * The clock the ORM writes comes from the executor (a `now` slot truncated to the column's fraction digits): SQLite
   * has no sub-second clock function, and a PostgreSQL clock rounds into timestamp(p < 6) (docs/spec/protocol.md "Clock").
   */
  hostNow: boolean;
  /**
   * A datetime(p) column as it compares with the six-digit clock of a value function: SQLite compares text, so a
   * column with p < 6 is extended with zeros to six fraction digits; MySQL and PostgreSQL compare values.
   */
  clockOperand(col: string, precision: number): string;
  /** A row lock suffix; undefined when the mode is unknown. */
  rowLock(mode: string): string | undefined;
  columnFunction(name: string, col: string, arg: (i: number) => string): string | undefined;
  valueFunction(name: string, arg: () => string, now: () => string): string | undefined;
  containsBinary(col: string, value: (transform: string) => string): string;
  /** A full-text match of cols against value, in boolean mode when boolean is set; undefined when the dialect has no full-text search (DIA-187). */
  fulltext(cols: readonly string[], value: (transform: string) => string, boolean: boolean): string | undefined;
  tupleIn(cols: readonly string[], rows: readonly (readonly string[])[], negate: boolean): string;
  random(): string;
  /** The clause that sorts NULL before every value ascending and after every value descending; PostgreSQL alone needs it. */
  nullsOrder(desc: boolean): string;
  /** A statement that restarts a table's identity column from the value after the largest key. If the table is empty, the next key is 1. */
  restartIdentity(table: string, column: string): string;
}

function quoteWith(q: string, ident: string): string {
  return ident.split('.').map(part => q + part.replaceAll(q, q + q) + q).join('.');
}

/** Quotes text as an SQL string literal. */
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
  readTime: col => `CAST(${col} AS CHAR)`,
  writeTime: ph => ph,
  readUuid: col => col,
  writeUuid: ph => ph,
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
      if (s === 'ip') expr = `INET6_ATON(${expr})`;
    }
    return expr;
  },
  now: precision => precision > 0 ? `CURRENT_TIMESTAMP(${precision})` : 'CURRENT_TIMESTAMP',
  handlesStage: s => s === 'ip',
  decodesStage: s => s === 'ip',
  hostNow: false,
  clockOperand: col => col,
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
    return guardResult(() => `${name.endsWith('_later') ? 'DATE_ADD' : 'DATE_SUB'}(NOW(6), INTERVAL ${guardInterval(unit, '', arg)} ${unit.toUpperCase()})`);
  },
  // utf8mb4_0900_bin compares code points under LIKE; LIKE BINARY is deprecated since MySQL 8.0.27.
  containsBinary: (col, value) => `${col} LIKE ${value('like_contains')}`,
  fulltext: (cols, value, boolean) => `MATCH (${cols.join(', ')}) AGAINST (${boolean ? value('fulltext_boolean') + ' IN BOOLEAN MODE' : value('') + ' IN NATURAL LANGUAGE MODE'})`,
  tupleIn: (cols, rows, negate) => tupleIn(cols, rows, negate, false),
  random: () => 'RAND()',
  nullsOrder: () => '',
  // InnoDB sets AUTO_INCREMENT, when the column's largest value is at or below it, to the largest value plus 1, so 1
  // is always after the largest key. It is DDL, so it commits the open transaction.
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
  readTime: (col, precision) => (precision === 0 ? `to_char(${col}, 'HH24:MI:SS')` : `substr(to_char(${col}, 'HH24:MI:SS.US'), 1, ${9 + precision})`),
  writeTime: ph => `CAST(CAST(${ph} AS text) AS time)`,
  readUuid: col => `CAST(${col} AS text)`,
  writeUuid: ph => `CAST(CAST(${ph} AS text) AS uuid)`,
  now: () => 'CURRENT_TIMESTAMP',
  handlesStage: () => false,
  decodesStage: () => false,
  hostNow: true,
  clockOperand: col => col,
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
  // The executor clock is bound, so one statement has one clock: now() is the transaction start and
  // statement_timestamp() the statement start (postgres.now.transaction_start).
  valueFunction(name, arg, now) {
    if (name === 'now') return `CAST(${now()} AS timestamp(6))`;
    if (name === 'today') return 'CURRENT_DATE';
    const unit = valueFunctionUnits[name];
    if (unit === undefined) return undefined;
    const fields: Readonly<Record<string, string>> = { second: 'secs', minute: 'mins', hour: 'hours', day: 'days', month: 'months' };
    const field = fields[unit];
    if (field === undefined) throw new Error(`the interval unit ${unit} has no make_interval field`);
    const cast = field === 'secs' ? 'double precision' : 'integer';
    const operandCast = cast === 'double precision' ? cast : 'bigint';
    return guardResult(() => {
      const clock = `CAST(${now()} AS timestamp(6))`;
      return `(${clock}${name.endsWith('_later') ? ' + ' : ' - '}make_interval(${field} => CAST(${guardInterval(unit, operandCast, arg)} AS ${cast})))`;
    });
  },
  containsBinary: (col, value) => `${col} LIKE ${value('like_contains')}`,
  fulltext: (cols, value, boolean) => `to_tsvector('simple', ${cols.map(c => `coalesce(${c}, '')`).join(" || ' ' || ")}) @@ ${boolean ? 'websearch_to_tsquery' : 'plainto_tsquery'}('simple', ${value('')})`,
  tupleIn: (cols, rows, negate) => tupleIn(cols, rows, negate, false),
  random: () => 'random()',
  nullsOrder: desc => (desc ? ' NULLS LAST' : ' NULLS FIRST'),
  // Sets the identity sequence to the largest key plus 1 and makes is_called false, so the next nextval returns that value.
  // The first argument of pg_get_serial_sequence is read as an identifier, so it is the quoted table name, and the second
  // argument is the column name as it is.
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
  readTime: col => col,
  writeTime: ph => ph,
  readUuid: col => col,
  writeUuid: ph => ph,
  now: () => 'CURRENT_TIMESTAMP',
  handlesStage: () => false,
  decodesStage: () => false,
  hostNow: true,
  clockOperand: (col, precision) => (precision >= 6 ? col : precision === 0 ? `(${col} || '.000000')` : `(${col} || '${'0'.repeat(6 - precision)}')`),
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
    return guardResult(() => {
      const clock = now();
      const modifier = `${sign} || CAST(${arg()} AS TEXT) || ' ${unit}s'${unit === 'month' ? ", 'floor'" : ''}`;
      return `(datetime(${clock}, ${modifier}) || substr(${now()}, 20))`;
    });
  },
  // SQLite LIKE ignores ASCII case.
  containsBinary: (col, value) => `instr(${col}, ${value('')}) > 0`,
  fulltext: () => undefined,
  tupleIn: (cols, rows, negate) => tupleIn(cols, rows, negate, true),
  random: () => 'random()',
  nullsOrder: () => '',
  // The next key of an AUTOINCREMENT table is the seq in sqlite_sequence plus 1, so the seq is set to the largest key.
  // If the table has never received a row and sqlite_sequence has no row for it, the next key is already after the largest key.
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
