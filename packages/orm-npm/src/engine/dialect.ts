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

export type RowLockMode = 'update' | 'share' | 'update_nowait' | 'share_nowait';

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
  /** The codec stage runs in SQL; every other stage runs in the executor. */
  handlesStage(stage: string): boolean;
  /** The database has no sub-second clock; the executor binds the time. */
  hostNow: boolean;
  /** A row lock suffix; undefined when the mode is unknown. */
  rowLock(mode: string): string | undefined;
  columnFunction(name: string, col: string, arg: (i: number) => string): string | undefined;
  valueFunction(name: string, arg: () => string, now: () => string): string | undefined;
  containsBinary(col: string, value: (transform: string) => string): string;
  tupleIn(cols: readonly string[], rows: readonly (readonly string[])[], negate: boolean): string;
  random(): string;
}

export function quoteWith(q: string, ident: string): string {
  return ident.split('.').map(part => q + part.replaceAll(q, q + q) + q).join('.');
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

/** AES is host-side so the row key version selects the key; hex and ip are SQL-side. */
export const mysql: Dialect = {
  name: 'mysql',
  quote: ident => quoteWith('`', ident),
  placeholder: () => '?',
  like: (col, ph) => `${col} LIKE ${ph}`,
  limit: (offset, count) => ` LIMIT ${offset}, ${count}`,
  forceIndex: name => ` FORCE INDEX (${quoteWith('`', name)})`,
  insertReturningId: false,
  upsert: (_, assigns) => ` ON DUPLICATE KEY UPDATE ${assigns}`,
  readExpr(col, stages) {
    let expr = col;
    for (let i = stages.length - 1; i >= 0; i--) {
      if (stages[i] === 'hex') expr = `UNHEX(${expr})`;
      else if (stages[i] === 'ip') expr = `INET6_NTOA(${expr})`;
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
  hostNow: false,
  rowLock: lockSuffix,
  columnFunction(name, col, arg) {
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
};

/** Every codec stage is host-side: an ip value is stored as bytes in a bytea column. */
export const postgres: Dialect = {
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
  hostNow: false,
  rowLock: lockSuffix,
  columnFunction(name, col, arg) {
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
    const field = ({ second: 'secs', minute: 'mins', hour: 'hours', day: 'days', month: 'months' } as Record<string, string>)[unit]!;
    const cast = field === 'secs' ? 'double precision' : 'integer';
    return `(now()${name.endsWith('_later') ? ' + ' : ' - '}make_interval(${field} => CAST(${arg()} AS ${cast})))`;
  },
  containsBinary: (col, value) => `${col} LIKE ${value('like_contains')}`,
  tupleIn: (cols, rows, negate) => tupleIn(cols, rows, negate, false),
  random: () => 'random()',
};

/** Every codec stage is host-side. */
export const sqlite: Dialect = {
  name: 'sqlite',
  quote(ident) {
    const parts = ident.split('.');
    return quoteWith('"', parts.length === 1 ? parts[0]! : parts.join('__'));
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
  hostNow: true,
  // The executor takes an ORM-owned lock row; the SQL suffix stays empty.
  rowLock: mode => lockSuffix(mode) === undefined ? undefined : '',
  columnFunction(name, col, arg) {
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
};

export function dialectOf(name: string): Dialect | undefined {
  switch (name) {
    case 'mysql': return mysql;
    case 'postgres': return postgres;
    case 'sqlite': return sqlite;
  }
  return undefined;
}
