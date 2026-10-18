// The IR executor client of flowmark that serves markdown:// connections (docs/protocol.md §5 "IR executors", docs/dialects.md "Markdown IR
// executor"). The client validates the request and sends it as an IR executor message without planning it, and assembles the answer's rows
// into models.
import { connect as netConnect, type Socket } from 'node:net';
import { parse as parseJson, type Value } from '@polyspec/ordered-json';
import { checkAssign, checkParam, useSlotType } from './bind_check.js';
import { hostEncode } from './codec.js';
import { decodeAssembly, timeValue, type Db, type Executor, type Result } from './database.js';
import type { PoolBounds, PoolStats } from './driver.js';
import { functionType, paramUses, type ParamUse } from './engine/params.js';
import { entityOf, fieldOf, type Entity, type RuntimeModel } from './engine/model.js';
import { validate } from './engine/validate.js';
import type { Assemble, Child, OutputColumn, Request, RequestQuery, Subquery } from './ir.js';
import { present } from './present.js';
import { OrmError } from './runtime_error.js';
import * as codes from './codes.js';

/** The flowmark server address, corpus name and token of a markdown:// DSN (docs/protocol.md §5 "IR executors"). */
export interface MarkdownDsn {
  readonly address: string;
  readonly corpus: string;
  readonly token: string;
}

const dsnForm = 'markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>';

/**
 * Reads markdown://127.0.0.1:<port>/<corpus>?token=<token>. The flowmark server listens only on 127.0.0.1, and the token
 * travels in plaintext, so the host is 127.0.0.1 only.
 */
export function parseMarkdownDsn(url: URL): MarkdownDsn {
  if (url.username !== '' || url.password !== '') throw new OrmError(codes.CONFIG, `${dsnForm}; it takes no user`);
  if (url.hostname !== '127.0.0.1') throw new OrmError(codes.CONFIG, `${dsnForm}; host ${JSON.stringify(url.hostname)}: a flowmark server listens on 127.0.0.1 only`);
  const port = Number(url.port);
  if (!/^[0-9]+$/.test(url.port) || port < 1 || port > 65535) throw new OrmError(codes.CONFIG, `${dsnForm}; port ${JSON.stringify(url.port)} is not 1 to 65535: give the port that flowmark serve printed`);
  let corpus: string;
  try { corpus = decodeURIComponent(url.pathname.replace(/^\//, '')); } catch { corpus = ''; }
  if (corpus === '' || corpus.includes('/')) throw new OrmError(codes.CONFIG, `${dsnForm}; the path ${JSON.stringify(url.pathname)} is not one corpus name: give the corpus root's directory name`);
  const tokens = url.searchParams.getAll('token');
  const [token] = tokens;
  if (tokens.length !== 1 || token === undefined || token === '') throw new OrmError(codes.CONFIG, `${dsnForm}; give one token, the token of .flowmark/server.json of the corpus`);
  for (const key of url.searchParams.keys()) {
    if (key !== 'token') throw new OrmError(codes.CONFIG, `${dsnForm}; it does not accept ${key}`);
  }
  return { address: `${url.hostname}:${port}`, corpus, token };
}

function canceled(): OrmError {
  return new OrmError(codes.CANCELED, 'the call was cancelled');
}

/** One control message: begin(read_only), commit, rollback, savepoint, release, rollback_to(name). */
function controlLine(op: string, readOnly = false, name = ''): string {
  return JSON.stringify({ op, ...(readOnly ? { read_only: true } : {}), ...(name !== '' ? { name } : {}) });
}

/**
 * One connection to the flowmark server, that is, one server session. Only one call uses it at a time: the pool hands it out, or a transaction
 * holds it. Lines the server writes are received as socket events and kept.
 */
export class MarkdownSession {
  /** Means the connection can no longer be used: a read or write failed, a signal cut it, or the server ended it. */
  public broken = false;
  public readonly created = performance.now();
  private partial = '';
  private readonly lines: string[] = [];
  private ended: Error | undefined;
  private wake: (() => void) | undefined;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.partial += chunk;
      for (let at = this.partial.indexOf('\n'); at >= 0; at = this.partial.indexOf('\n')) {
        this.lines.push(this.partial.slice(0, at));
        this.partial = this.partial.slice(at + 1);
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
    let text: string;
    try {
      this.socket.write(`${line}\n`);
      text = await this.next();
    } catch (error) {
      this.close();
      if (signal?.aborted) throw canceled();
      throw new OrmError(codes.CONNECTION_LOST, `the flowmark server connection broke: ${error instanceof Error ? error.message : String(error)}`, error);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    let answer: Value | undefined;
    try { answer = parseJson(text); } catch { answer = undefined; }
    if (answer === undefined || answer.kind !== 'object') {
      this.close();
      throw new OrmError(codes.INTERNAL, `the flowmark server answered ${JSON.stringify(text)}, not a JSON object`);
    }
    const failure = answer.get('error');
    if (failure !== undefined) {
      const code = failure.kind === 'object' ? failure.get('code') : undefined;
      const message = failure.kind === 'object' ? failure.get('message') : undefined;
      if (code?.kind !== 'string' || code.stringValue() === '') {
        this.close();
        throw new OrmError(codes.INTERNAL, `the flowmark server answered the error ${failure.raw} without a code`);
      }
      // The server closes the connection after writing CONNECTION_LOST (idle transaction).
      if (code.stringValue() === codes.CONNECTION_LOST) this.close();
      throw new OrmError(code.stringValue(), message?.kind === 'string' ? message.stringValue() : '');
    }
    return answer;
  }

  private async next(): Promise<string> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.ended !== undefined) throw this.ended;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

/** The session pool of a markdown connection. Open sessions never exceed bounds.size, and idle sessions are kept up to bounds.idleSize. */
export class MarkdownPool {
  private idle: MarkdownSession[] = [];
  private open = 0;
  private inUse = 0;
  private closed = false;
  private waiters: Array<() => void> = [];

  public constructor(private readonly dsn: MarkdownDsn, private readonly bounds: PoolBounds) {}

  /** Hands out an idle session or connects a new one. If bounds.size sessions are in use, waits until one comes back. */
  public async acquire(signal: AbortSignal | undefined): Promise<MarkdownSession> {
    while (!this.closed && this.inUse >= this.bounds.size) await this.wait(signal);
    if (this.closed) throw new OrmError(codes.CONFIG, 'database is closed');
    for (let s = this.idle.pop(); s !== undefined; s = this.idle.pop()) {
      if (s.broken || (this.bounds.lifetimeMs > 0 && performance.now() - s.created >= this.bounds.lifetimeMs)) {
        s.close();
        this.open--;
        continue;
      }
      this.inUse++;
      return s;
    }
    this.open++;
    this.inUse++;
    try {
      return await MarkdownSession.dial(this.dsn, signal);
    } catch (error) {
      this.open--;
      this.inUse--;
      this.wakeOne();
      throw error;
    }
  }

  private wait(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(canceled());
    return new Promise((resolve, reject) => {
      const waiter = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { this.waiters = this.waiters.filter(w => w !== waiter); reject(canceled()); };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private wakeOne(): void {
    this.waiters.shift()?.();
  }

  /** Returns a session to the pool. A broken session and a session of a closed pool are closed. */
  public release(s: MarkdownSession): void {
    this.inUse--;
    if (s.broken || this.closed || this.idle.length >= this.bounds.idleSize) {
      s.close();
      this.open--;
    } else this.idle.push(s);
    this.wakeOne();
  }

  public close(): void {
    this.closed = true;
    for (const s of this.idle) {
      s.close();
      this.open--;
    }
    this.idle = [];
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  public stats(): PoolStats {
    return { maxOpenConnections: this.bounds.size, openConnections: this.open, inUse: this.inUse, idle: this.idle.length };
  }
}

/** The control message that opens a transaction. A read-only transaction sends read_only. */
export function beginLine(readOnly: boolean): string { return controlLine('begin', readOnly); }

/** The control message that ends a transaction: commit or rollback. */
export function endLine(op: 'commit' | 'rollback'): string { return controlLine(op); }

/** Savepoint control message: savepoint, release, rollback_to. */
export function savepointLine(op: 'savepoint' | 'release' | 'rollback_to', name: string): string { return controlLine(op, false, name); }

/**
 * The runtime value model JSON of parameter i: decimal is a string, bytes are base64, datetime is UTC
 * YYYY-MM-DD HH:MM:SS.ffffff, date is YYYY-MM-DD, time is HH:MM:SS.ffffff (the digits after p are 0, and string values match too). Which form is used is decided by the
 * type of the slot that the parameter fills. A slot of a hex or ip style column is sent with the value encoded by the client, as in an SQL connection.
 */
export function markdownParam(db: Pick<Db, 'zone' | 'aesKey'>, i: number, value: unknown, uses: readonly ParamUse[]): string {
  const use = uses[0];
  if (use?.column !== undefined && value !== null && value !== undefined) {
    const host = use.column.stages.filter(s => s === 'aes' || s === 'hex' || s === 'ip');
    if (host.length > 0) value = hostEncode(value, host, db.aesKey);
  }
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'));
  if (typeof value === 'string' && use?.type === 'bytes') return JSON.stringify(Buffer.from(value).toString('base64'));
  if (typeof value === 'string' && (use?.type === 'date' || use?.type === 'time' || use?.type === 'datetime')) return JSON.stringify(timeValue(value, use.type, db.zone, 6));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} (${value}) has no JSON form`);
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  throw new OrmError(codes.CODEC_ENCODE, `parameter ${i} (${typeof value}) has no JSON form`);
}

/**
 * Validates the request and runs its request message {ir_version, manifest_hash, request, params, now} in the session of ex, then
 * returns the answer and the request's runtime model. Outside a transaction, one session from the pool is used for the duration of that request.
 */
async function markdownCall(ex: Executor, request: Request, params: readonly unknown[]): Promise<{ answer: Value; model: RuntimeModel }> {
  const db = ex.db;
  const model = db.markdownModel(request.manifest_hash);
  request.n_params = params.length;
  validate(model, request);
  const uses = paramUses(model, request);
  params.forEach((value, i) => {
    for (const use of uses[i] ?? []) {
      checkAssign(i, value, useSlotType(use));
      if (use.column?.stages.some(s => s === 'aes' || s === 'hex' || s === 'ip')) continue;
      checkParam(i, value, useSlotType(use), db.zone);
    }
  });
  const values = params.map((value, i) => markdownParam(db, i, value, uses[i] ?? []));
  const line = `{"ir_version":${JSON.stringify(request.ir_version)},"manifest_hash":${JSON.stringify(request.manifest_hash)},"request":${JSON.stringify(request)},"params":[${values.join(',')}],"now":${JSON.stringify(db.now(db.clockMicros(), 6))}}`;
  if (ex.frame !== undefined) return { answer: await present(ex.frame.md, 'the flowmark session of a markdown transaction').call(line, db.signal), model };
  const pool = present(db.md, 'the flowmark pool of a markdown database');
  const s = await pool.acquire(db.signal);
  try {
    return { answer: await s.call(line, db.signal), model };
  } finally {
    pool.release(s);
  }
}

function answerError(message: string): OrmError {
  return new OrmError(codes.INTERNAL, `the flowmark answer: ${message}`);
}

/** The join and relation rows that a markdown answer's row has in its last cell. */
export interface MarkdownLinks {
  readonly joins: Map<string, unknown[] | null>;
  readonly rels: Map<string, unknown[][]>;
}

/** The join and relation that a markdown answer's row had in its last cell. */
export function markdownLinks(row: readonly unknown[]): MarkdownLinks {
  const links = row[row.length - 1];
  if (links !== null && typeof links === 'object' && links instanceof LinksOf) return links;
  return new LinksOf();
}

class LinksOf implements MarkdownLinks {
  public readonly joins = new Map<string, unknown[] | null>();
  public readonly rels = new Map<string, unknown[][]>();
}

/** The type of a scalar subquery column. */
function subType(m: RuntimeModel, sub: Subquery): string {
  switch (sub.agg) {
    case 'count': return 'i64';
    case 'avg': return 'f64';
  }
  const ent = entityOf(m, sub.query.entity);
  return (ent !== undefined ? fieldOf(ent, sub.column ?? '')?.type : undefined) ?? 'text';
}

/**
 * One node of the answer: exactly one each of root, join, and relation. asm records the row layout of the node, and joins and rels are that join and
 * relation. The node's first row decides the columns of asm, and later rows must have the same outputs in the same order.
 */
class MarkdownNode {
  public readonly asm: Assemble;
  private readonly ent: Entity;
  private readonly joins = new Map<string, MarkdownNode>();
  private readonly rels = new Map<string, MarkdownNode>();
  private built = false;

  public constructor(private readonly m: RuntimeModel, private readonly q: RequestQuery, private readonly groups: boolean, private readonly db: Db) {
    this.ent = present(entityOf(m, q.entity), `entity ${q.entity}`);
    this.asm = { entity: this.ent.name, alias: '', columns: [], children: [], key: [] };
    for (const j of q.joins ?? []) {
      const child = new MarkdownNode(m, j.query, false, db);
      this.joins.set(j.rel, child);
      this.asm.children.push(childOf(j.rel, 'join', false, false, child.asm));
    }
    for (const rel of q.relations ?? []) {
      const child = new MarkdownNode(m, rel.query, false, db);
      this.rels.set(rel.rel, child);
      const target = present(entityOf(m, rel.query.entity), `entity ${rel.query.entity}`);
      const parentKeys = (rel.keys ?? []).map(k => k.left);
      const childKeys = (rel.keys ?? []).map(k => k.right);
      // If this row is the one that a relation row's foreign key points to, those rows belong to this row (as in the planner).
      const cascade = rel.query.no_cascade_delete !== true && sameList(parentKeys, this.ent.primaryKey) && !sameList(childKeys, target.primaryKey);
      this.asm.children.push(childOf(rel.rel, rel.kind ?? 'one', rel.query.flatten === true, cascade, child.asm));
    }
  }

  /** The placement of an output name: a subquery, a column function, or a column of the node's entity. Since the markdown executor leaves all codec stages to the client, the whole codec of the column is the style to decode. */
  private outCol(name: string, index: number): OutputColumn {
    if (this.groups && name === 'row_count') return { index, name, column: '', type: 'i64', styles: [], hidden: false };
    const c = this.q.columns;
    if (c !== undefined && !this.groups) {
      const sub = c.sub?.[name];
      if (sub !== undefined) return { index, name, column: '', type: subType(this.m, sub), styles: [], hidden: false };
      const cf = c.fn?.[name];
      if (cf !== undefined) return { index, name, column: cf.column, type: functionType(cf.fn.name, fieldOf(this.ent, cf.column)), styles: [], hidden: false };
    }
    const f = fieldOf(this.ent, name);
    if (f === undefined) throw answerError(`${this.ent.name} answers ${name}, which is no output of the request`);
    return { index, name, column: name, type: f.type, styles: [...f.stages], hidden: false };
  }

  /** Takes the columns and key of asm from the first row's outputs of the node. */
  public build(outputs: readonly string[]): void {
    outputs.forEach((name, i) => this.asm.columns.push(this.outCol(name, i)));
    const keys = this.groups ? this.q.group_by ?? [] : this.ent.primaryKey;
    for (const key of keys) {
      const index = outputs.indexOf(key);
      if (index < 0) throw answerError(`${this.ent.name} answers no ${key}, a key of its rows`);
      this.asm.key.push({ column: key, index });
    }
    this.built = true;
  }

  /** Reads one answer row as the position row of the node layout: the output values, and in the last cell the join and relation rows. */
  public row(raw: Value): unknown[] {
    if (raw.kind !== 'object') throw answerError(`a row of ${this.ent.name} is ${raw.raw}, not a JSON object`);
    const members = [...raw.members];
    const outputs = members.filter(([name]) => !this.joins.has(name) && !this.rels.has(name)).map(([name]) => name);
    if (!this.built) this.build(outputs);
    if (outputs.length !== this.asm.columns.length) throw answerError(`a row of ${this.ent.name} answers ${JSON.stringify(outputs)}, another output than its first row`);
    const values: unknown[] = Array.from({ length: outputs.length + 1 });
    const links = new LinksOf();
    let k = 0;
    for (const [name, value] of members) {
      const join = this.joins.get(name);
      if (join !== undefined) {
        links.joins.set(name, value.kind === 'null' ? null : join.row(value));
        continue;
      }
      const rel = this.rels.get(name);
      if (rel !== undefined) {
        links.rels.set(name, rel.relationRows(value));
        continue;
      }
      const col = this.asm.columns[k];
      if (col === undefined) throw answerError(`a row of ${this.ent.name} answers more columns than its first row`);
      if (col.name !== name) throw answerError(`a row of ${this.ent.name} answers ${name} where its first row answers ${col.name}`);
      try {
        values[k] = answerValue(col.type, value);
      } catch (error) {
        if (!(error instanceof OrmError)) throw error;
        throw new OrmError(error.code, `${this.ent.name}.${col.name}: ${error.message}`);
      }
      k++;
    }
    // A join has its own row, so it decodes only the node's own columns. The corpus catalog rejects aes columns, so
    // there is no keyring (docs/dialects.md).
    decodeAssembly(values, { ...this.asm, children: [] }, this.db);
    values[outputs.length] = links;
    return values;
  }

  /** Reads a relation's value as a list of rows: a one relation is an object or null, a many relation is an array, and a key_by relation is an object grouped by key. */
  public relationRows(raw: Value): unknown[][] {
    if (raw.kind === 'null') return [];
    if (raw.kind === 'array') return this.rows(raw.items);
    if ((this.q.key_by ?? '') !== '' && raw.kind === 'object') return this.rows([...raw.members.values()]);
    return [this.row(raw)];
  }

  public rows(items: readonly Value[]): unknown[][] {
    return items.map(item => this.row(item));
  }

  /** A group_count node of an answer with no rows is laid out by the request's group column and row_count. */
  public buildGroups(): void {
    if (!this.built) this.build([...this.q.group_by ?? [], 'row_count']);
  }
}

function childOf(rel: string, kind: string, flatten: boolean, cascade: boolean, assemble: Assemble): Child {
  return { rel, kind, step: -1, parent_keys: [], child_keys: [], key: [], flatten, cascade, assemble };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Reads one answer value as a cell of the column type. The value is the same runtime value model as a parameter. */
function answerValue(type: string, raw: Value): unknown {
  if (raw.kind === 'null') return null;
  const bad = () => new OrmError(codes.CODEC_DECODE, `the answer value ${raw.raw} is not a ${type} value`);
  switch (type) {
    case 'i16': case 'i32': case 'i64':
      if (raw.kind !== 'number' || !/^-?[0-9]+$/.test(raw.numberLiteral())) throw bad();
      return Number(raw.numberLiteral());
    case 'f64':
      if (raw.kind !== 'number') throw bad();
      return Number(raw.numberLiteral());
    case 'bool':
      if (raw.kind !== 'boolean') throw bad();
      return raw.booleanValue();
    case 'bytes': {
      if (raw.kind !== 'string') throw bad();
      const text = raw.stringValue();
      const bytes = Buffer.from(text, 'base64');
      if (bytes.toString('base64') !== text) throw bad();
      return new Uint8Array(bytes);
    }
  }
  if (raw.kind !== 'string') throw bad();
  return raw.stringValue();
}

/** The value of sum and avg answers, and the key of an inserted row: an integer, a decimal, a decimal string, or null if none. */
function aggregateValue(raw: Value): number | string | null {
  switch (raw.kind) {
    case 'null': return null;
    case 'number': return Number(raw.numberLiteral());
    case 'string': return raw.stringValue();
  }
  throw answerError(`the value ${raw.raw} is no number`);
}

/** Reads the answer to a row read (one, all, group_count, paginate) as a positional result. The result's plan is one layout of the root node, and the last cell of each row is its join and relation. */
export async function markdownRead(ex: Executor, request: Request, params: readonly unknown[]): Promise<{ result: Result; total: number }> {
  const { answer, model } = await markdownCall(ex, request, params);
  const rows = answer.get('rows');
  if (rows?.kind !== 'array') throw answerError(`a ${request.kind} answer ${answer.raw} has no rows`);
  const count = answer.get('count');
  if (request.kind === 'paginate' && count?.kind !== 'number') throw answerError(`a paginate answer ${answer.raw} has no count`);
  const root = new MarkdownNode(model, request, request.kind === 'group_count', ex.db);
  const main = root.rows(rows.items);
  if (request.kind === 'group_count') root.buildGroups();
  const result: Result = {
    plan: { manifest_hash: request.manifest_hash, kind: request.kind, steps: [{ id: 0, role: 'main', sql: '', tables: [], bind_slots: [], assemble: root.asm }] },
    main, steps: new Map(), params, markdown: true,
  };
  return { result, total: count?.kind === 'number' ? Number(count.numberLiteral()) : 0 };
}

/** The answer to count, sum, and avg. */
export async function markdownScalar(ex: Executor, request: Request, params: readonly unknown[]): Promise<unknown> {
  const { answer } = await markdownCall(ex, request, params);
  if (request.kind === 'count') {
    const count = answer.get('count');
    if (count?.kind !== 'number') throw answerError(`a count answer ${answer.raw} has no count`);
    return Number(count.numberLiteral());
  }
  const value = answer.get('value');
  if (value === undefined) throw answerError(`a ${request.kind} answer ${answer.raw} has no value`);
  return aggregateValue(value);
}

/** The answer to write, {affected, keys}. keys holds the primary keys of the inserted rows in insert order: an identity is an integer, and a key_prefix key is text. */
export async function markdownWrite(ex: Executor, request: Request, params: readonly unknown[]): Promise<{ keys: Array<number | string | null>; affected: number }> {
  const { answer } = await markdownCall(ex, request, params);
  const affected = answer.get('affected');
  if (affected?.kind !== 'number') throw answerError(`a ${request.kind} answer ${answer.raw} has no affected`);
  const keys = answer.get('keys');
  const out = keys?.kind === 'array' ? keys.items.map(aggregateValue) : [];
  const n = Number(affected.numberLiteral());
  if (request.kind === 'update' && request.optimistic !== undefined && n === 0) throw new OrmError(codes.OPTIMISTIC_LOCK, 'the row changed after it was read');
  return { keys: out, affected: n };
}
