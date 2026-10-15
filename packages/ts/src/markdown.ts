// markdown:// 연결의 flowmark IR executor client다(docs/protocol.md §5 "IR executors", docs/dialects.md "Markdown IR
// executor"). client는 request를 검증하고 plan하지 않은 채 IR executor message로 보내며, 답의 행을 model로
// 조립한다.
import { connect as netConnect, type Socket } from 'node:net';
import { parse as parseJson, type Value } from '@polyspec/ordered-json';
import { checkParam, useSlotType } from './bind_check.js';
import { hostEncode } from './codec.js';
import { decodeAssembly, formatInstant, timeValue, type Db, type Executor, type Result } from './database.js';
import type { PoolBounds, PoolStats } from './driver.js';
import { functionType, paramUses, type ParamUse } from './engine/params.js';
import { entityOf, fieldOf, type Entity, type RuntimeModel } from './engine/model.js';
import { validate } from './engine/validate.js';
import type { Assemble, Child, OutputColumn, Request, RequestQuery, Subquery } from './ir.js';
import { present } from './present.js';
import { OrmError } from './runtime_error.js';

/** markdown:// DSN의 flowmark server 주소, corpus 이름, token이다(docs/protocol.md §5 "IR executors"). */
export interface MarkdownDsn {
  readonly address: string;
  readonly corpus: string;
  readonly token: string;
}

const dsnForm = 'markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>';

/**
 * markdown://127.0.0.1:<port>/<corpus>?token=<token>을 읽는다. flowmark server는 127.0.0.1에서만 듣고 token은
 * 평문으로 가므로 host는 127.0.0.1뿐이다.
 */
export function parseMarkdownDsn(url: URL): MarkdownDsn {
  if (url.username !== '' || url.password !== '') throw new OrmError('CONFIG', `${dsnForm}; it takes no user`);
  if (url.hostname !== '127.0.0.1') throw new OrmError('CONFIG', `${dsnForm}; host ${JSON.stringify(url.hostname)}: a flowmark server listens on 127.0.0.1 only`);
  const port = Number(url.port);
  if (!/^[0-9]+$/.test(url.port) || port < 1 || port > 65535) throw new OrmError('CONFIG', `${dsnForm}; port ${JSON.stringify(url.port)} is not 1 to 65535: give the port that flowmark serve printed`);
  let corpus: string;
  try { corpus = decodeURIComponent(url.pathname.replace(/^\//, '')); } catch { corpus = ''; }
  if (corpus === '' || corpus.includes('/')) throw new OrmError('CONFIG', `${dsnForm}; the path ${JSON.stringify(url.pathname)} is not one corpus name: give the corpus root's directory name`);
  const tokens = url.searchParams.getAll('token');
  const [token] = tokens;
  if (tokens.length !== 1 || token === undefined || token === '') throw new OrmError('CONFIG', `${dsnForm}; give one token, the token of .flowmark/server.json of the corpus`);
  for (const key of url.searchParams.keys()) {
    if (key !== 'token') throw new OrmError('CONFIG', `${dsnForm}; it does not accept ${key}`);
  }
  return { address: `${url.hostname}:${port}`, corpus, token };
}

function canceled(): OrmError {
  return new OrmError('CANCELED', 'the call was cancelled');
}

/** control message 하나다: begin(read_only), commit, rollback, savepoint, release, rollback_to(name). */
function controlLine(op: string, readOnly = false, name = ''): string {
  return JSON.stringify({ op, ...(readOnly ? { read_only: true } : {}), ...(name !== '' ? { name } : {}) });
}

/**
 * flowmark server와의 연결 하나, 곧 server session 하나다. 한 번에 한 호출이 쓴다: pool이 내주거나 transaction이
 * 잡는다. server가 쓰는 줄은 socket event로 받아 둔다.
 */
export class MarkdownSession {
  /** 연결을 더 쓸 수 없음을 뜻한다: 읽기나 쓰기가 실패했거나 signal이 끊었거나 server가 연결을 끝냈다. */
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

  /** server에 연결하고 첫 message connect로 corpus와 token을 보낸다. */
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
      throw new OrmError('DRIVER', `connecting to the flowmark server ${dsn.address}: ${error instanceof Error ? error.message : String(error)}; start flowmark serve for the corpus`, error);
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
   * message 하나를 한 줄로 보내고 답 한 줄을 읽는다. 답이 {"error": {code, message}}이면 그 code의 오류다. signal이
   * 끝나면 연결을 끊는다: server는 끊긴 연결의 transaction을 rollback하고 lock을 푼다.
   */
  public async call(line: string, signal: AbortSignal | undefined): Promise<Value> {
    if (this.broken) throw new OrmError('CONNECTION_LOST', 'the flowmark session has ended');
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
      throw new OrmError('CONNECTION_LOST', `the flowmark server connection broke: ${error instanceof Error ? error.message : String(error)}`, error);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    let answer: Value | undefined;
    try { answer = parseJson(text); } catch { answer = undefined; }
    if (answer === undefined || answer.kind !== 'object') {
      this.close();
      throw new OrmError('INTERNAL', `the flowmark server answered ${JSON.stringify(text)}, not a JSON object`);
    }
    const failure = answer.get('error');
    if (failure !== undefined) {
      const code = failure.kind === 'object' ? failure.get('code') : undefined;
      const message = failure.kind === 'object' ? failure.get('message') : undefined;
      if (code?.kind !== 'string' || code.stringValue() === '') {
        this.close();
        throw new OrmError('INTERNAL', `the flowmark server answered the error ${failure.raw} without a code`);
      }
      // server는 CONNECTION_LOST를 쓴 뒤 연결을 닫는다(idle transaction).
      if (code.stringValue() === 'CONNECTION_LOST') this.close();
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

/** markdown 연결의 session pool이다. 열린 session은 bounds.size를 넘지 않고, 쉬는 session은 bounds.idleSize까지 남긴다. */
export class MarkdownPool {
  private idle: MarkdownSession[] = [];
  private open = 0;
  private inUse = 0;
  private closed = false;
  private waiters: Array<() => void> = [];

  public constructor(private readonly dsn: MarkdownDsn, private readonly bounds: PoolBounds) {}

  /** 쉬는 session을 내주거나 새로 연결한다. 쓰는 session이 bounds.size이면 하나가 돌아올 때까지 기다린다. */
  public async acquire(signal: AbortSignal | undefined): Promise<MarkdownSession> {
    while (!this.closed && this.inUse >= this.bounds.size) await this.wait(signal);
    if (this.closed) throw new OrmError('CONFIG', 'database is closed');
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

  /** session을 pool에 돌려준다. 끊긴 session과 닫힌 pool의 session은 닫는다. */
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

/** transaction을 여는 control message다. 읽기 전용 transaction은 read_only를 보낸다. */
export function beginLine(readOnly: boolean): string { return controlLine('begin', readOnly); }

/** transaction을 끝내는 control message다: commit이나 rollback. */
export function endLine(op: 'commit' | 'rollback'): string { return controlLine(op); }

/** savepoint control message다: savepoint, release, rollback_to. */
export function savepointLine(op: 'savepoint' | 'release' | 'rollback_to', name: string): string { return controlLine(op, false, name); }

/**
 * parameter i의 runtime value model JSON이다: decimal은 string, bytes는 base64, datetime은 UTC의
 * YYYY-MM-DD HH:MM:SS.ffffff, date는 YYYY-MM-DD, time은 HH:MM:SS.ffffff다(p 뒤 자리는 0, 문자열 값도 같다). 어느 form인지는 parameter가 채우는
 * slot의 type이 정한다. hex와 ip style column의 slot은 SQL 연결처럼 client가 값을 encode해 보낸다.
 */
export function markdownParam(db: Pick<Db, 'zone' | 'aesKey'>, i: number, value: unknown, uses: readonly ParamUse[]): string {
  const use = uses[0];
  if (use?.column !== undefined && value !== null && value !== undefined) {
    const host = use.column.stages.filter(s => s === 'aes' || s === 'hex' || s === 'ip');
    if (host.length > 0) value = hostEncode(value, host, db.aesKey);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new OrmError('CODEC_ENCODE', `parameter ${i} is an invalid Date`);
    const text = formatInstant(value, db.zone);
    value = use?.type === 'date' ? text.slice(0, 10) : use?.type === 'time' ? text.slice(11) : text;
  }
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'));
  if (typeof value === 'string' && use?.type === 'bytes') return JSON.stringify(Buffer.from(value).toString('base64'));
  if (typeof value === 'string' && (use?.type === 'date' || use?.type === 'time' || use?.type === 'datetime')) return JSON.stringify(timeValue(value, use.type, db.zone, 6));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) throw new OrmError('CODEC_ENCODE', `parameter ${i} (${value}) has no JSON form`);
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  throw new OrmError('CODEC_ENCODE', `parameter ${i} (${typeof value}) has no JSON form`);
}

/**
 * request를 검증하고 그 request message {ir_version, manifest_hash, request, params, now}를 ex의 session에서 실행해
 * 답과 request의 runtime model을 돌려준다. transaction 밖이면 pool의 session 하나를 그 request 동안 쓴다.
 */
async function markdownCall(ex: Executor, request: Request, params: readonly unknown[]): Promise<{ answer: Value; model: RuntimeModel }> {
  const db = ex.db;
  const model = db.markdownModel(request.manifest_hash);
  request.n_params = params.length;
  validate(model, request);
  const uses = paramUses(model, request);
  params.forEach((value, i) => {
    for (const use of uses[i] ?? []) {
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
  return new OrmError('INTERNAL', `the flowmark answer: ${message}`);
}

/** markdown 답의 행이 마지막 칸에 가지는 join과 relation 행이다. */
export interface MarkdownLinks {
  readonly joins: Map<string, unknown[] | null>;
  readonly rels: Map<string, unknown[][]>;
}

/** markdown 답의 행이 마지막 칸에 가진 join과 relation이다. */
export function markdownLinks(row: readonly unknown[]): MarkdownLinks {
  const links = row[row.length - 1];
  if (links !== null && typeof links === 'object' && links instanceof LinksOf) return links;
  return new LinksOf();
}

class LinksOf implements MarkdownLinks {
  public readonly joins = new Map<string, unknown[] | null>();
  public readonly rels = new Map<string, unknown[][]>();
}

/** scalar subquery column의 type이다. */
function subType(m: RuntimeModel, sub: Subquery): string {
  switch (sub.agg) {
    case 'count': return 'i64';
    case 'avg': return 'f64';
  }
  const ent = entityOf(m, sub.query.entity);
  return (ent !== undefined ? fieldOf(ent, sub.column ?? '')?.type : undefined) ?? 'text';
}

/**
 * 답의 한 node다: root, join, relation 하나가 하나씩이다. asm은 node의 행 배치를 적고 joins와 rels는 그 join과
 * relation이다. asm의 column은 node의 첫 행이 정하고 그 뒤 행은 같은 output을 같은 순서로 가져야 한다.
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
      // 이 행이 relation 행의 외래 key가 가리키는 행이면 그 행들은 이 행에 속한다(planner와 같다).
      const cascade = rel.query.no_cascade_delete !== true && sameList(parentKeys, this.ent.primaryKey) && !sameList(childKeys, target.primaryKey);
      this.asm.children.push(childOf(rel.rel, rel.kind ?? 'one', rel.query.flatten === true, cascade, child.asm));
    }
  }

  /** output name의 배치다: subquery, column 함수, 아니면 node entity의 column이다. markdown executor는 모든 codec stage를 client에 맡기므로 column의 codec 전체가 decode할 style이다. */
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

  /** node의 첫 행의 output으로 asm의 column과 key를 정한다. */
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

  /** 답의 행 하나를 node 배치의 위치 행으로 읽는다: output 값, 그리고 마지막 칸에 join과 relation의 행이다. */
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
    // join은 자기 행을 가지므로 node 자신의 column만 decode한다. corpus catalog은 aes column을 거절하므로
    // keyring이 없다(docs/dialects.md).
    decodeAssembly(values, { ...this.asm, children: [] }, this.db);
    values[outputs.length] = links;
    return values;
  }

  /** relation의 값을 행 목록으로 읽는다: one relation은 object나 null, many relation은 array, key_by relation은 key로 묶은 object다. */
  public relationRows(raw: Value): unknown[][] {
    if (raw.kind === 'null') return [];
    if (raw.kind === 'array') return this.rows(raw.items);
    if ((this.q.key_by ?? '') !== '' && raw.kind === 'object') return this.rows([...raw.members.values()]);
    return [this.row(raw)];
  }

  public rows(items: readonly Value[]): unknown[][] {
    return items.map(item => this.row(item));
  }

  /** 행이 없는 답의 group_count node는 그 request의 group column과 row_count로 배치를 정한다. */
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

/** 답의 값 하나를 column type의 cell로 읽는다. 값은 parameter와 같은 runtime value model이다. */
function answerValue(type: string, raw: Value): unknown {
  if (raw.kind === 'null') return null;
  const bad = () => new OrmError('CODEC_DECODE', `the answer value ${raw.raw} is not a ${type} value`);
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

/** sum과 avg 답의 값과 insert한 행의 key다: 정수, 소수, decimal string, 없으면 null이다. */
function aggregateValue(raw: Value): number | string | null {
  switch (raw.kind) {
    case 'null': return null;
    case 'number': return Number(raw.numberLiteral());
    case 'string': return raw.stringValue();
  }
  throw answerError(`the value ${raw.raw} is no number`);
}

/** row read(one, all, group_count, paginate)의 답을 위치 result로 읽는다. result의 plan은 root node의 배치 하나이고, 각 행의 마지막 칸이 그 join과 relation이다. */
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

/** count, sum, avg의 답이다. */
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

/** write의 답 {affected, keys}이다. keys는 insert한 행의 primary key를 insert 순서로 담는다: identity는 정수, key_prefix key는 text다. */
export async function markdownWrite(ex: Executor, request: Request, params: readonly unknown[]): Promise<{ keys: Array<number | string | null>; affected: number }> {
  const { answer } = await markdownCall(ex, request, params);
  const affected = answer.get('affected');
  if (affected?.kind !== 'number') throw answerError(`a ${request.kind} answer ${answer.raw} has no affected`);
  const keys = answer.get('keys');
  const out = keys?.kind === 'array' ? keys.items.map(aggregateValue) : [];
  const n = Number(affected.numberLiteral());
  if (request.kind === 'update' && request.optimistic !== undefined && n === 0) throw new OrmError('OPTIMISTIC_LOCK', 'the row changed after it was read');
  return { keys: out, affected: n };
}
