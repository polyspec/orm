// The client of a flowmark server that serves markdown:// connections (docs/spec/protocol.md §5 "Markdown connections",
// docs/spec/dialects.md "Markdown"). A flowmark server runs a statement of SQL in SQLite's dialect on the corpus (DIA-185), so a
// markdown connection is a SQLite connection whose statements the server answers: the driver below sends each statement in a
// statement message and reads its answer as node:sqlite reads a row.
import { isUtf8 } from 'node:buffer';
import { quote, quoteBytes } from './message.js';
import { connect as netConnect, type Socket } from 'node:net';
import { parse as parseJson, ParseError, type Value } from '@polyspec/ordered-json';
import { checkHostEscape, checkTimezone, decodedPath, dsnParameter, dsnPragmas, observed, type DriverColumn, type DsnParameters, type DriverPool, type DriverResult, type DriverSession, type DriverValue, type PoolBounds, type PoolStats, type RowSink, type StatementDone } from './driver.js';
import { ConnectionPool } from './pool.js';
import { OrmError } from './runtime_error.js';
import * as codes from './codes.js';

/** The flowmark server address, corpus name and token of a markdown:// DSN (docs/spec/protocol.md §5 "IR executors"). */
export interface MarkdownDsn {
  readonly address: string;
  readonly corpus: string;
  readonly token: string;
  /** The _pragma values of the DSN, name and value, which each session states first, as on a SQLite DSN. */
  readonly pragmas: ReadonlyArray<readonly [string, string]>;
}

const dsnForm = 'markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>';

/**
 * Reads markdown://127.0.0.1:<port>/<corpus>?token=<token>. The flowmark server listens only on 127.0.0.1, and the token
 * travels in plaintext, so the host is 127.0.0.1 only.
 */
export function parseMarkdownDsn(url: URL, path: string, parameters: DsnParameters): MarkdownDsn {
  // The order of PRT-63, after the fragment and the query that parseDsn has read by CFG-20: the token, the user, the host, the
  // port, the corpus path, then the timezone and the _pragma values.
  const token = dsnParameter(parameters, 'token');
  if (token === undefined) throw new OrmError(codes.CONFIG, `markdown DSN is missing the parameter ${quote('token')}`);
  if (url.username !== '' || url.password !== '') throw new OrmError(codes.CONFIG, `${dsnForm}; it takes no user`);
  checkHostEscape('markdown', url);
  if (url.hostname !== '127.0.0.1') throw new OrmError(codes.CONFIG, `${dsnForm}; host ${quote(url.hostname)}: a flowmark server listens on 127.0.0.1 only`);
  const port = Number(url.port);
  if (!/^[0-9]+$/.test(url.port) || port < 1 || port > 65535) throw new OrmError(codes.CONFIG, `${dsnForm}; port ${quote(url.port)} is not 1 to 65535: give the port that flowmark serve printed`);
  // The path is decoded as every DSN path is (CFG-11); one that does not decode is no corpus name.
  const decoded = decodedPath(path);
  const corpus = decoded?.startsWith('/') ? decoded.slice(1) : '';
  if (corpus === '' || corpus === '.' || corpus === '..' || /[/\0]/.test(corpus)) throw new OrmError(codes.CONFIG, `${dsnForm}; the path ${quote(path)} is not one corpus name: give the corpus root's directory name`);
  checkTimezone(parameters);
  const pragmas = dsnPragmas('markdown', parameters);
  return { address: `${url.hostname}:${port}`, corpus, token, pragmas };
}

function canceled(): OrmError {
  return new OrmError(codes.CANCELED, 'the call was cancelled');
}

/**
 * One connection to the flowmark server, that is, one server session. Only one call uses it at a time: the pool hands it out, or a transaction
 * holds it. Lines the server writes are received as socket events and kept.
 */
class MarkdownSession {
  /** Means the connection can no longer be used: a read or write failed, a signal cut it, or the server ended it. */
  public broken = false;
  public readonly created = performance.now();
  // The bytes of the server's lines: a line is decoded only once it is checked to be UTF-8, so that a byte that is not UTF-8
  // reaches the message of the answer as it came (INT-187) and is never replaced.
  private partial: Buffer = Buffer.alloc(0);
  private readonly lines: Buffer[] = [];
  private ended: Error | undefined;
  private wake: (() => void) | undefined;

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.partial = Buffer.concat([this.partial, chunk]);
      for (let at = this.partial.indexOf(0x0a); at >= 0; at = this.partial.indexOf(0x0a)) {
        this.lines.push(this.partial.subarray(0, at));
        this.partial = this.partial.subarray(at + 1);
      }
      this.notify();
    });
    socket.on('error', error => { this.end(error); });
    socket.on('close', () => { this.end(new Error('the server closed the connection')); });
  }

  private end(error: Error): void {
    this.ended ??= error;
    this.broken = true;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** Connects to the server, and the first message, connect, sends the corpus and token. */
  public static async dial(dsn: MarkdownDsn, signal: AbortSignal | undefined): Promise<MarkdownSession> {
    if (signal?.aborted) throw canceled();
    const at = dsn.address.lastIndexOf(':');
    const s = new MarkdownSession(netConnect({ host: dsn.address.slice(0, at), port: Number(dsn.address.slice(at + 1)), family: 4 }));
    const abort = () => s.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        s.socket.once('connect', () => resolve());
        s.wake = () => reject(s.ended);
      });
    } catch (error) {
      s.close();
      if (signal?.aborted) throw canceled();
      throw new OrmError(codes.DRIVER, `connecting to the flowmark server ${dsn.address}: ${error instanceof Error ? error.message : String(error)}; start flowmark serve for the corpus`, error);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    s.wake = undefined;
    try {
      await s.call(JSON.stringify({ op: 'connect', corpus: dsn.corpus, token: dsn.token }), signal);
    } catch (error) {
      s.close();
      throw error;
    }
    return s;
  }

  public close(): void {
    this.broken = true;
    this.socket.destroy();
  }

  /**
   * Sends one message as one line and reads one answer line. If the answer is {"error": {code, message}}, it is an error with that code. If the signal
   * ends, the connection is disconnected: the server rolls back the transaction of the disconnected connection and releases the lock.
   */
  public async call(line: string, signal: AbortSignal | undefined): Promise<Value> {
    if (this.broken) throw new OrmError(codes.CONNECTION_LOST, 'the flowmark session has ended');
    if (signal?.aborted) {
      this.close();
      throw canceled();
    }
    const abort = () => this.close();
    signal?.addEventListener('abort', abort, { once: true });
    let bytes: Buffer;
    try {
      this.socket.write(`${line}\n`);
      bytes = await this.next();
    } catch (error) {
      this.close();
      if (signal?.aborted) throw canceled();
      throw new OrmError(codes.CONNECTION_LOST, `the flowmark server connection broke: ${error instanceof Error ? error.message : String(error)}`, error);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    let answer: Value | undefined;
    if (isUtf8(bytes)) {
      try {
        answer = parseJson(bytes.toString('utf8'));
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        answer = undefined;
      }
    }
    if (answer === undefined || answer.kind !== 'object') {
      this.close();
      throw new OrmError(codes.INTERNAL, `the flowmark server answered ${quoteBytes(bytes)}, not a JSON object`);
    }
    const failure = answer.get('error');
    if (failure !== undefined) {
      const code = failure.kind === 'object' ? failure.get('code') : undefined;
      const message = failure.kind === 'object' ? failure.get('message') : undefined;
      const result = failure.kind === 'object' ? failure.get('result_code') : undefined;
      if (code?.kind !== 'string' || code.stringValue() === '') {
        this.close();
        throw new OrmError(codes.INTERNAL, `the flowmark server answered the error ${failure.raw} without a code`);
      }
      // The server closes the connection after writing CONNECTION_LOST (idle transaction).
      if (code.stringValue() === codes.CONNECTION_LOST) this.close();
      // The cause is the refusal as a SQLite driver states it: its result code, since the statements are in SQLite's dialect.
      const text = message?.kind === 'string' ? message.stringValue() : '';
      throw new OrmError(code.stringValue(), text, { code: code.stringValue(), message: text, errcode: result?.kind === 'number' ? Number(result.numberLiteral()) : 0 });
    }
    return answer;
  }

  private async next(): Promise<Buffer> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.ended !== undefined) throw this.ended;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

/** The wire form of a column of a statement answer. */
interface AnswerColumn { name: string; type: string; }

/** One statement answer, or one fetch answer of the rows that go on. */
interface StatementAnswer { columns: DriverColumn[]; rows: unknown[][]; affected: number; lastInsertId: bigint; more: boolean; }

function answerError(what: string, raw: string): OrmError {
  return new OrmError(codes.INTERNAL, `the answer of a ${what}: ${raw}`);
}

/**
 * The wire form of a bound value (PRT-67): a JSON value, and the form that an answer writes for a value that JSON cannot hold:
 * {"bytes": base64} for bytes and {"float": "+Inf"} or {"float": "-Inf"} for an infinity. A boolean binds as 1 or 0, as on a
 * SQLite connection.
 */
function statementParam(value: DriverValue): string {
  if (value instanceof Uint8Array) return JSON.stringify({ bytes: Buffer.from(value).toString('base64') });
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && !Number.isFinite(value)) {
    if (Number.isNaN(value)) throw new OrmError(codes.CONFIG, 'a statement parameter of NaN has no JSON form');
    return JSON.stringify({ float: value > 0 ? '+Inf' : '-Inf' });
  }
  return JSON.stringify(value);
}

/**
 * Reads one cell of an answer as node:sqlite reads it on a SQLite connection: an integer as a bigint, a fraction as a number,
 * a text as a string, a blob as a Uint8Array, or null.
 */
function statementCell(raw: Value): unknown {
  switch (raw.kind) {
    case 'null': return null;
    case 'string': return raw.stringValue();
    case 'number': {
      const literal = raw.numberLiteral();
      return /^-?[0-9]+$/.test(literal) ? BigInt(literal) : Number(literal);
    }
    case 'object': {
      const float = raw.get('float');
      if (float?.kind === 'string' && (float.stringValue() === '+Inf' || float.stringValue() === '-Inf')) return float.stringValue() === '+Inf' ? Infinity : -Infinity;
      const text = raw.get('text');
      // A text is its text when it is valid UTF-8 and its bytes when not, as a SQLite connection reads it (COD-69).
      if (text?.kind === 'string') {
        const stored = new Uint8Array(base64(text.stringValue(), raw.raw));
        return isUtf8(stored) ? Buffer.from(stored).toString('utf8') : stored;
      }
      const bytes = raw.get('bytes');
      if (bytes?.kind === 'string') return new Uint8Array(base64(bytes.stringValue(), raw.raw));
    }
  }
  throw answerError('statement', `the cell ${raw.raw} is no value`);
}

/** The bytes of the base64 text of cell raw. */
function base64(text: string, raw: string): Buffer {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) throw answerError('statement', `the cell ${raw} holds no base64 text`);
  return bytes;
}

/** Reads a statement or fetch answer; columns holds the columns of the statement for a fetch, whose answer names none. */
function readAnswer(what: string, answer: Value, columns: DriverColumn[] | undefined): StatementAnswer {
  const rows = answer.get('rows');
  if (rows !== undefined && rows.kind !== 'array') throw answerError(what, answer.raw);
  const read: unknown[][] = (rows?.kind === 'array' ? rows.items : []).map(row => {
    if (row.kind !== 'array') throw answerError(what, answer.raw);
    return row.items.map(statementCell);
  });
  const number = (name: string): bigint => {
    const value = answer.get(name);
    if (value === undefined) return 0n;
    if (value.kind !== 'number' || !/^-?[0-9]+$/.test(value.numberLiteral())) throw answerError(what, answer.raw);
    return BigInt(value.numberLiteral());
  };
  const more = answer.get('more');
  if (more !== undefined && more.kind !== 'boolean') throw answerError(what, answer.raw);
  let cols = columns;
  if (cols === undefined) {
    const list = answer.get('columns');
    if (list !== undefined && list.kind !== 'array') throw answerError(what, answer.raw);
    cols = (list?.kind === 'array' ? list.items : []).map((column): AnswerColumn => {
      const name = column.kind === 'object' ? column.get('name') : undefined;
      const type = column.kind === 'object' ? column.get('type') : undefined;
      if (name?.kind !== 'string' || (type !== undefined && type.kind !== 'string' && type.kind !== 'null')) throw answerError(what, answer.raw);
      return { name: name.stringValue(), type: type?.kind === 'string' ? type.stringValue() : '' };
    });
  }
  return { columns: cols, rows: read, affected: Number(number('affected')), lastInsertId: number('last_insert_id'), more: more?.kind === 'boolean' && more.booleanValue() };
}

/** Runs one statement in session s and returns its first rows. */
async function statement(s: MarkdownSession, sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined): Promise<StatementAnswer> {
  const line = `{"op":"statement","sql":${JSON.stringify(sql)},"params":[${params.map(statementParam).join(',')}]}`;
  return readRows(s, 'statement', await s.call(line, signal), undefined);
}

/** The rows that go on after a, which the server holds until a fetch reads the last of them. */
async function fetchMore(s: MarkdownSession, a: StatementAnswer, signal: AbortSignal | undefined): Promise<StatementAnswer> {
  return readRows(s, 'fetch', await s.call('{"op":"fetch"}', signal), a.columns);
}

/**
 * Reads an answer of session s. A row that the read refuses stops it: when more rows follow, close ends them, and the refusal is
 * the error whatever the close answers (PRT-66).
 */
async function readRows(s: MarkdownSession, what: string, answer: Value, columns: DriverColumn[] | undefined): Promise<StatementAnswer> {
  try {
    return readAnswer(what, answer, columns);
  } catch (error) {
    const more = answer.get('more');
    if (more?.kind === 'boolean' && more.booleanValue()) await closeRows(s);
    throw error;
  }
}

/**
 * Ends the rows that session s holds (PRT-66). A close that the server refuses leaves the rows to the next statement, which ends
 * them, so the session stays usable; a close whose connection broke has closed the session in call.
 */
async function closeRows(s: MarkdownSession): Promise<void> {
  await s.call('{"op":"close"}', undefined).catch(() => undefined);
}

/** Runs one statement and reads all its rows, as a SQLite connection reads them: a statement with rows answers their count as its affected. */
async function execute(s: MarkdownSession, sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined): Promise<DriverResult> {
  let a = await statement(s, sql, params, signal);
  const rows = [...a.rows];
  const columns = a.columns;
  while (a.more) {
    a = await fetchMore(s, a, signal);
    rows.push(...a.rows);
  }
  if (columns.length === 0) return { rows, affected: a.affected, insertId: a.lastInsertId, columns };
  const first = rows[0]?.[0];
  return { rows, affected: rows.length, insertId: typeof first === 'string' || typeof first === 'number' || typeof first === 'bigint' ? first : null, columns };
}

/** Streams the rows of one statement into sink; when the sink stops before the end, close ends the rows the server still holds. */
async function scan(s: MarkdownSession, sql: string, params: readonly DriverValue[], sink: RowSink): Promise<void> {
  let a = await statement(s, sql, params, undefined);
  sink.columns(a.columns);
  for (;;) {
    for (const row of a.rows) {
      if (sink.row(row)) continue;
      if (a.more) await closeRows(s);
      return;
    }
    if (!a.more) return;
    a = await fetchMore(s, a, undefined);
  }
}

/** Opens a session of dsn and states its _pragma values first. */
async function dialStatements(dsn: MarkdownDsn, signal: AbortSignal | undefined): Promise<MarkdownSession> {
  const s = await MarkdownSession.dial(dsn, signal);
  try {
    for (const [name, value] of dsn.pragmas) await statement(s, `PRAGMA ${name} = ${value}`, [], signal);
  } catch (error) {
    s.close();
    throw error;
  }
  return s;
}

/**
 * The driver pool of a markdown connection: the statements of the SQLite dialect run in flowmark sessions, so the pool is a
 * SQLite pool to every surface of the connection.
 */
class MarkdownPoolDriver implements DriverPool {
  public readonly name = 'sqlite' as const;
  // A flowmark server answers SQL in SQLite's dialect, as its server (DIA-185, DIA-203).
  public readonly server = 'sqlite' as const;
  public constructor(private readonly pool: ConnectionPool<MarkdownSession>) {}
  public async execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    const s = await this.pool.acquire(signal);
    try {
      return await observed(this.name, sql, done, 'statement', () => execute(s, sql, params, signal));
    } finally {
      this.pool.release(s);
    }
  }
  public async reserve(_shared = false, signal?: AbortSignal): Promise<DriverSession> {
    return new MarkdownDriverSession(await this.pool.acquire(signal), this.pool);
  }
  public stats(): PoolStats { return this.pool.stats(); }
  public async close(): Promise<void> { this.pool.close(); }
}

/**
 * One held flowmark session as a driver session. It reports no transaction state: a flowmark session keeps its transaction open
 * after a failed statement, so it has no rollback of its own to learn of.
 */
class MarkdownDriverSession implements DriverSession {
  public readonly name = 'sqlite' as const;
  private released = false;
  public constructor(private readonly s: MarkdownSession, private readonly pool: ConnectionPool<MarkdownSession>) {}
  public execute(sql: string, params: readonly DriverValue[], signal: AbortSignal | undefined, done: StatementDone): Promise<DriverResult> {
    return observed(this.name, sql, done, 'statement', () => execute(this.s, sql, params, signal));
  }
  public control(sql: string, params: readonly DriverValue[], done: StatementDone, signal?: AbortSignal): Promise<DriverResult> {
    return observed(this.name, sql, done, 'statement', () => execute(this.s, sql, params, signal));
  }
  public scan(sql: string, params: readonly DriverValue[], sink: RowSink, done: StatementDone): Promise<void> {
    return observed(this.name, sql, done, 'statement', () => scan(this.s, sql, params, sink));
  }
  public release(discard: boolean): void {
    if (this.released) return;
    this.released = true;
    if (discard) this.s.close();
    this.pool.release(this.s);
  }
}

/** Opens the driver pool of a markdown DSN. */
export function openMarkdown(dsn: MarkdownDsn, bounds: PoolBounds): DriverPool {
  return new MarkdownPoolDriver(new ConnectionPool(bounds, signal => dialStatements(dsn, signal), canceled));
}
