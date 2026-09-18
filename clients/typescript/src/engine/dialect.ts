// Database-specific SQL pieces (docs/dialects.md). The planner never writes a
// quote or a placeholder itself.

/** Replaced in trusted expression fragments with the advancing wall clock. */
export const CURRENT_TIME_TOKEN = '$CURRENT_TIME';

export const EARTH_RADIUS_METERS = '6370986';

/** Column types each column function accepts. */
export const columnFunctionTypes: Readonly<Record<string, readonly string[]>> = {
  day_of_week: ['date', 'datetime'],
  year: ['date', 'datetime'],
  month: ['date', 'datetime'],
  date: ['date', 'datetime'],
  distance: ['point'],
  point_x: ['point'],
  point_y: ['point'],
};

/** Function arguments of each column function, not counting the compared value. */
export const columnFunctionArity: Readonly<Record<string, number>> = {
  day_of_week: 0, year: 0, month: 0, date: 0, distance: 2, point_x: 0, point_y: 0,
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
  fulltext(cols: readonly string[], ph: string, boolean: boolean): string;
  insertReturningId: boolean;
  upsert(conflict: readonly string[], assigns: string): string;
  /** Wraps the SQL-side read stages of a style pipeline. */
  readExpr(col: string, colType: string, styles: readonly string[]): string;
  /** Wraps a bound value with the SQL-side write stages. */
  writeExpr(ph: () => string, colType: string, styles: readonly string[]): string;
  now(): string;
  currentTime(): string;
  supports(op: string): boolean;
  handlesStyle(style: string): boolean;
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

/** The great-circle distance; x2 and y2 are called once per occurrence. */
function haversine(x1: string, y1: string, x2: () => string, y2: () => string): string {
  const rad = (v: string) => `RADIANS(${v})`;
  return `(2 * ${EARTH_RADIUS_METERS} * ASIN(SQRT(POWER(SIN((${rad(y2())} - ${rad(y1)}) / 2), 2) + COS(${rad(y1)}) * COS(${rad(y2())}) * POWER(SIN((${rad(x2())} - ${rad(x1)}) / 2), 2))))`;
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
  fulltext: (cols, ph, boolean) => `MATCH(${cols.join(', ')}) AGAINST (${ph}${boolean ? ' IN BOOLEAN MODE' : ' IN NATURAL LANGUAGE MODE'})`,
  insertReturningId: false,
  upsert: (_, assigns) => ` ON DUPLICATE KEY UPDATE ${assigns}`,
  readExpr(col, colType, styles) {
    let expr = colType === 'point' ? `ST_AsText(${col})` : col;
    for (let i = styles.length - 1; i >= 0; i--) {
      if (styles[i] === 'hex') expr = `UNHEX(${expr})`;
      else if (styles[i] === 'ip') expr = `INET6_NTOA(${expr})`;
    }
    return expr;
  },
  writeExpr(ph, colType, styles) {
    let expr = ph();
    if (colType === 'point') expr = `ST_PointFromText(${expr})`;
    for (const s of styles) {
      if (s === 'hex') expr = `HEX(${expr})`;
      else if (s === 'ip') expr = `INET6_ATON(${expr})`;
    }
    return expr;
  },
  now: () => 'CURRENT_TIMESTAMP',
  currentTime: () => 'CURRENT_TIMESTAMP',
  supports: () => true,
  handlesStyle: s => s === 'hex' || s === 'ip',
  hostNow: false,
  rowLock: lockSuffix,
  columnFunction(name, col, arg) {
    switch (name) {
      case 'day_of_week': return `DAYOFWEEK(${col})`;
      case 'year': return `YEAR(${col})`;
      case 'month': return `MONTH(${col})`;
      case 'date': return `DATE(${col})`;
      case 'distance': return `ST_Distance_Sphere(${col}, POINT(${arg(0)}, ${arg(1)}))`;
      case 'point_x': return `ST_X(${col})`;
      case 'point_y': return `ST_Y(${col})`;
    }
    return undefined;
  },
  valueFunction(name, arg) {
    if (name === 'now') return 'NOW()';
    if (name === 'today') return 'CURDATE()';
    const unit = valueFunctionUnits[name];
    if (unit === undefined) return undefined;
    return `${name.endsWith('_later') ? 'DATE_ADD' : 'DATE_SUB'}(NOW(), INTERVAL ${arg()} ${unit.toUpperCase()})`;
  },
  containsBinary: (col, value) => `${col} LIKE BINARY ${value('like_contains')}`,
  tupleIn: (cols, rows, negate) => tupleIn(cols, rows, negate, false),
  random: () => 'RAND()',
};

/** AES and hex stay host-side; ip is SQL-side. */
export const postgres: Dialect = {
  name: 'postgres',
  quote: ident => quoteWith('"', ident),
  placeholder: n => `$${n}`,
  like: (col, ph) => `${col} ILIKE ${ph}`,
  limit: (offset, count) => ` LIMIT ${count} OFFSET ${offset}`,
  forceIndex: () => '',
  fulltext(cols, ph, boolean) {
    const doc = cols.length > 1 ? `coalesce(${cols.join(", '') || ' ' || coalesce(")}, '')` : cols.join(" || ' ' || ");
    return `to_tsvector('simple', ${doc}) @@ ${boolean ? 'websearch_to_tsquery' : 'plainto_tsquery'}('simple', ${ph})`;
  },
  insertReturningId: true,
  upsert: conflictUpsert,
  readExpr(col, colType, styles) {
    if (colType === 'point') col = `(${col})::text`;
    return styles.includes('ip') ? `host(${col})` : col;
  },
  writeExpr(ph, colType, styles) {
    let expr = ph();
    if (colType === 'point') expr = `CAST(${expr} AS text)::point`;
    for (const s of styles) if (s === 'ip') expr = `(${expr})::inet`;
    return expr;
  },
  now: () => 'CURRENT_TIMESTAMP',
  currentTime: () => 'clock_timestamp()',
  supports: () => true,
  handlesStyle: s => s === 'ip',
  hostNow: false,
  rowLock: lockSuffix,
  columnFunction(name, col, arg) {
    switch (name) {
      case 'day_of_week': return `(EXTRACT(DOW FROM ${col})::int + 1)`;
      case 'year': return `EXTRACT(YEAR FROM ${col})::int`;
      case 'month': return `EXTRACT(MONTH FROM ${col})::int`;
      case 'date': return `CAST(${col} AS date)`;
      case 'distance': return haversine(`${col}[0]`, `${col}[1]`, () => `CAST(${arg(0)} AS double precision)`, () => `CAST(${arg(1)} AS double precision)`);
      case 'point_x': return `${col}[0]`;
      case 'point_y': return `${col}[1]`;
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

/** One coordinate of the stored `POINT(x y)` text. */
function sqlitePointCoordinate(col: string, second: boolean): string {
  const space = `instr(${col}, ' ')`;
  if (second) return `CAST(substr(${col}, ${space} + 1, length(${col}) - ${space} - 1) AS REAL)`;
  return `CAST(substr(${col}, 7, ${space} - 7) AS REAL)`;
}

/** Every style stage is host-side; full-text search is not available. */
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
  fulltext() { throw new Error('sqlite: fulltext is rejected by supports'); },
  insertReturningId: true,
  upsert: conflictUpsert,
  readExpr: col => col,
  writeExpr: ph => ph(),
  now: () => 'CURRENT_TIMESTAMP',
  currentTime: () => 'CURRENT_TIMESTAMP',
  supports: op => op !== 'match' && op !== 'match_boolean',
  handlesStyle: () => false,
  hostNow: true,
  // The executor takes an ORM-owned lock row; the SQL suffix stays empty.
  rowLock: mode => lockSuffix(mode) === undefined ? undefined : '',
  columnFunction(name, col, arg) {
    switch (name) {
      case 'day_of_week': return `(CAST(strftime('%w', ${col}) AS INTEGER) + 1)`;
      case 'year': return `CAST(strftime('%Y', ${col}) AS INTEGER)`;
      case 'month': return `CAST(strftime('%m', ${col}) AS INTEGER)`;
      case 'date': return `date(${col})`;
      case 'distance': return haversine(sqlitePointCoordinate(col, false), sqlitePointCoordinate(col, true), () => arg(0), () => arg(1));
      case 'point_x': return sqlitePointCoordinate(col, false);
      case 'point_y': return sqlitePointCoordinate(col, true);
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
    const clock = now();
    const modifier = `${sign} || CAST(${arg()} AS TEXT) || ' ${unit}s'`;
    return unit === 'month' ? `datetime(${clock}, ${modifier}, 'floor')` : `datetime(${clock}, ${modifier})`;
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
