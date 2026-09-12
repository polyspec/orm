import { AesKeyring } from './index.js';
import type { AesRotationSpec, AesRotationStatus, Compiler, Database, Executor, Param, Plan, PlanStep, Request, StreamResult, TransactionOptions } from './index.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ConnectCompiler, ConnectPlanCompiler, type CompilerTransport } from './compiler.js';
import { loadConfig, resolveAesKey, resolveBlindIndexKey } from './config.js';
import { blindIndex, decode, hostDecode, hostEncode, parsePoint, pointText } from './codec.js';
import type { DriverConnection, DriverTransaction, DriverValue } from './driver.js';
import { openMySql, openPostgres, openSqlite } from './driver.js';
import { ExecutionRows, Page, Row, rowCollection, rowFromResult, rowKey, scalarKey } from './model.js';
import { OrmError } from './runtime_error.js';
import { generatedSchemaHash } from './registry.js';

export interface QueryEvent { sql: string; binds: readonly unknown[]; seconds: number; error?: unknown; }
export interface DatabaseOptions {
  schemaHash: string;
  compiler: CompilerTransport;
  aesKey?: string;
  blindIndexKey?: string;
  aesVersion?: number;
  aesKeys?: ReadonlyMap<number, string>;
  onQuery?: (event: QueryEvent) => void;
  planCacheSize?: number;
  statementCacheSize?: number;
}

function mysqlDsn(dsn: string, user?: string, password?: string): string {
  let url: URL;
  try { url = new URL(dsn); } catch (error) { throw new OrmError('CONFIG', `db.dsn must be a MySQL URL: ${(error as Error).message}`); }
  if (url.protocol !== 'mysql:') throw new OrmError('CONFIG', 'db.dsn must use mysql://');
  const declaredUser = decodeURIComponent(url.username);
  if (declaredUser !== '' && user !== undefined && declaredUser !== user) throw new OrmError('CONFIG', `db.user ${user} conflicts with the user in db.dsn ${declaredUser}`);
  if (declaredUser === '' && user === undefined) throw new OrmError('CONFIG', 'db.user is required when db.dsn has no user');
  if (declaredUser === '') url.username = user!;
  if (url.password === '' && password !== undefined) url.password = password;
  else if (url.password !== '' && password !== undefined && decodeURIComponent(url.password) !== password) throw new OrmError('CONFIG', 'db.password conflicts with the password in db.dsn');
  return url.toString();
}

export class Db implements Database, Executor {
  public readonly compiler: Compiler;
  public readonly schemaHash: string;
  private readonly plans = new Map<string, Plan>();
  private readonly planOrder: string[] = [];
  private readonly planCacheSize: number;
  public constructor(
    protected readonly connection: DriverConnection,
    options: DatabaseOptions,
    protected readonly root: Db | undefined = undefined,
  ) {
    this.schemaHash = options.schemaHash;
	this.planCacheSize = options.planCacheSize ?? 256;
	if (!Number.isSafeInteger(this.planCacheSize) || this.planCacheSize < 1) throw new OrmError('CONFIG', 'plan cache size must be a positive integer');
    const statementCacheSize = options.statementCacheSize ?? 256;
    if (!Number.isSafeInteger(statementCacheSize) || statementCacheSize < 1) throw new OrmError('CONFIG', 'statement cache size must be a positive integer');
    this.compiler = new ConnectPlanCompiler(options.compiler);
    this.aesKey = options.aesKey ?? '';
    this.blindIndexKey = options.blindIndexKey ?? '';
    this.aesVersion = options.aesVersion ?? 1;
    if (!Number.isSafeInteger(this.aesVersion) || this.aesVersion < 1) throw new OrmError('CONFIG', 'aes version must be a positive integer');
    this.onQuery = options.onQuery;
    this.aesKeyring = options.aesKeys === undefined && this.aesKey === '' ? undefined : new AesKeyring(options.aesKeys ?? new Map([[this.aesVersion, this.aesKey]]), this.aesVersion);
  }
  protected readonly aesKey: string;
  protected readonly blindIndexKey: string;
  protected readonly aesVersion: number;
  protected readonly aesKeyring?: AesKeyring;
  protected readonly onQuery?: (event: QueryEvent) => void;
  public get executor(): Executor { return this; }
  public get driver(): string { return this.connection.name; }

  public static async connect(connection: DriverConnection, options: DatabaseOptions): Promise<Db> {
    const metadata = await options.compiler.metadata();
    if (metadata.schemaHash !== options.schemaHash) throw new OrmError('SCHEMA_HASH_MISMATCH', `client schema ${options.schemaHash} but compiler loaded ${metadata.schemaHash}`);
    if (metadata.dialect !== connection.name) throw new OrmError('CONFIG', `driver ${connection.name} but compiler uses ${metadata.dialect}`);
    if (metadata.irVersion !== 1) throw new OrmError('VERSION_MISMATCH', `client IR version 1 but compiler uses ${metadata.irVersion}`);
    return new Db(connection, options);
  }
  public static mysql(uri: string, options: DatabaseOptions): Promise<Db> { return Db.connect(openMySql(uri, 10, options.statementCacheSize), options); }
  public static postgres(uri: string, options: DatabaseOptions): Promise<Db> { return Db.connect(openPostgres(uri, 10, options.statementCacheSize), options); }
  public static sqlite(path: string, options: DatabaseOptions): Promise<Db> { return Db.connect(openSqlite(path, options.statementCacheSize), options); }

  public static async fromConfig(path: string): Promise<Db> {
    const config = await loadConfig(path);
    const manifest = JSON.parse(await readFile(config.schema, 'utf8')) as { schema_hash?: unknown; entities?: Record<string, { columns?: Array<{ styles?: string[]; blind_index?: string }> }> };
    if (typeof manifest.schema_hash !== 'string' || manifest.schema_hash === '') throw new OrmError('CONFIG', `${config.schema}: schema_hash is required`);
    const generated = generatedSchemaHash();
    if (generated !== manifest.schema_hash) throw new OrmError('SCHEMA_HASH_MISMATCH', `generated from ${generated} but ${config.schema} contains ${manifest.schema_hash}`);
    const aesKey = resolveAesKey(config);
    const blindIndexKey = resolveBlindIndexKey(config);
    const hasAes = Object.values(manifest.entities ?? {}).some(entity => (entity.columns ?? []).some(column => column.styles?.includes('aes')));
    if (hasAes && aesKey === '') throw new OrmError('CONFIG', 'the schema has aes columns but secrets.aes or secrets.aes_env is not declared');
    const hasBlindIndex = Object.values(manifest.entities ?? {}).some(entity => (entity.columns ?? []).some(column => column.blind_index !== undefined));
    if (hasBlindIndex && blindIndexKey === '') throw new OrmError('CONFIG', 'the schema has blind indexes but secrets.blind_index or secrets.blind_index_env is not declared');
    const compiler = new ConnectCompiler(config.ormd.endpoint, config.ormd.timeout_ms);
    const onQuery = config.debug.on_query ? (event: QueryEvent) => {
      const detail = event.error === undefined ? '' : ` error=${String(event.error)}`;
      console.error(`orm ${(event.seconds * 1000).toFixed(3)}ms ${event.sql} ${JSON.stringify(event.binds)}${detail}`);
    } : undefined;
    const aesKeys = config.secrets.aes_keys === undefined ? undefined : new Map(Object.entries(config.secrets.aes_keys).map(([version, key]) => [Number(version), key] as const));
    const options = { schemaHash: manifest.schema_hash, compiler, aesKey, blindIndexKey, aesVersion: config.secrets.aes_version, aesKeys, onQuery, planCacheSize: config.db.plan_cache_size, statementCacheSize: config.db.statement_cache_size };
    if (config.db.driver === 'sqlite') return Db.connect(openSqlite(config.db.dsn, config.db.statement_cache_size), options);
    if (config.db.driver === 'postgres') return Db.connect(openPostgres(config.db.dsn, config.db.pool, config.db.statement_cache_size), options);
    return Db.connect(openMySql(mysqlDsn(config.db.dsn, config.db.user, config.db.password), config.db.pool, config.db.statement_cache_size), options);
  }

  public async close(): Promise<void> { await this.connection.close(); }

  public async aesStatus(spec: AesRotationSpec, keyring: AesKeyring): Promise<AesRotationStatus> {
    const table = this.identifier(spec.table); const version = this.identifier(spec.versionColumn);
    const result = await this.connection.execute(`SELECT ${version}, COUNT(*) FROM ${table} GROUP BY ${version} ORDER BY ${version}`, []);
    const versions: Record<string, number> = {}; let total = 0; let pending = 0;
    for (const row of result.rows) {
      const stored = Number(row[0]); const count = Number(row[1]);
      if (!Number.isSafeInteger(stored) || stored < 1 || !Number.isSafeInteger(count)) throw new OrmError('CODEC_DECODE', 'AES status returned an invalid version or count');
      versions[String(stored)] = count; total += count;
      if (stored !== keyring.currentVersion) pending += count;
    }
    return { current: keyring.currentVersion, total, pending, versions };
  }

  public async rotateAESRows(spec: AesRotationSpec, keyring: AesKeyring): Promise<number> {
    if (!(this instanceof Tx)) return this.transaction(transaction => transaction.rotateAESRows(spec, keyring));
    if (spec.columns.length === 0) throw new OrmError('CONFIG', 'AES rotation columns are empty');
    if (spec.primaryKeys.length === 0) throw new OrmError('CONFIG', 'AES rotation primary keys are empty');
    const table = this.identifier(spec.table); const primary = spec.primaryKeys.map(key => this.identifier(key)); const version = this.identifier(spec.versionColumn);
    const columns = spec.columns.map(column => this.identifier(column.name));
    const batchSize = spec.batchSize && spec.batchSize > 0 ? Math.floor(spec.batchSize) : 1000;
    const select = `SELECT ${primary.join(', ')}, ${version}, ${columns.join(', ')} FROM ${table} WHERE ${version} <> ${this.placeholder(1)} ORDER BY ${primary.join(', ')} LIMIT ${batchSize}`;
    const rows = (await this.connection.execute(select, [keyring.currentVersion])).rows;
    const sets = [...columns.map((column, index) => `${column} = ${this.placeholder(index + 1)}`), `${version} = ${this.placeholder(columns.length + 1)}`];
    const where = primary.map((key, index) => `${key} = ${this.placeholder(columns.length + 2 + index)}`);
    where.push(`${version} = ${this.placeholder(columns.length + 2 + primary.length)}`);
    const update = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`;
    for (const values of rows) {
      const row: Record<string, unknown> = {};
      spec.primaryKeys.forEach((key, index) => { row[key] = values[index]; });
      row[spec.versionColumn] = Number(values[primary.length]);
      spec.columns.forEach((column, index) => { row[column.name] = values[index + primary.length + 1]; });
      const rotated = keyring.rotateRow(row, spec.versionColumn, spec.columns, keyring.currentVersion, {
        decode: (value, styles, key) => hostDecode(value as string | Uint8Array, styles, key),
        encode: (value, styles, key) => hostEncode(value, styles, key),
      });
      const params = [...spec.columns.map(column => rotated[column.name]), keyring.currentVersion, ...values.slice(0, primary.length), Number(values[primary.length])] as DriverValue[];
      const result = await this.connection.execute(update, params);
      if (result.affected !== 1) throw new OrmError('OPTIMISTIC_LOCK', `AES rotation changed ${spec.table} primary key ${JSON.stringify(values.slice(0, primary.length))}`);
    }
    return rows.length;
  }
  public async transaction<T>(callback: (transaction: Tx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const attempts = options.retryDeadlocks ? Math.max(1, options.maxAttempts ?? 3) : 1;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const connection = await this.connection.begin({ isolation: options.isolation ?? 'default', readOnly: options.readOnly ?? false });
      const transaction = new Tx(connection, this);
      try {
        const result = await callback(transaction);
        await transaction.commit();
        return result;
      } catch (error) {
        if (transaction.active) await transaction.rollback();
        if (!options.retryDeadlocks || !(error instanceof OrmError) || error.code !== 'DEADLOCK') throw error;
        last = error;
        await new Promise(resolve => setTimeout(resolve, (50 << attempt) + Math.floor(Math.random() * 20)));
      }
    }
    throw last;
  }

  private identifier(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new OrmError('CONFIG', `invalid generated identifier ${value}`);
    return this.driver === 'mysql' ? `\`${value}\`` : `"${value}"`;
  }
  private placeholder(position: number): string { return this.driver === 'postgres' ? `$${position}` : '?'; }

  public async plan(request: Request): Promise<Plan> {
    const key = canonical(request);
    const cached = this.plans.get(key);
    if (cached) return cached;
    const plan = await this.compiler.compile(request);
    this.plans.set(key, plan);
    this.planOrder.push(key);
    while (this.planOrder.length > this.planCacheSize) {
      const oldest = this.planOrder.shift();
      if (oldest !== undefined) this.plans.delete(oldest);
    }
    return plan;
  }

  /** Validates and registers an ormgen precompiled plan for one request shape. */
  public loadPlanBundle(bundle: string | Record<string, unknown>, request: Request): void {
    let value: Record<string, unknown>;
    if (typeof bundle === 'string') {
      try { value = JSON.parse(bundle) as Record<string, unknown>; }
      catch (error) { throw new OrmError('CONFIG', `precompiled plan is invalid JSON: ${(error as Error).message}`); }
    } else value = bundle;
    if (value.version !== 1) throw new OrmError('VERSION_MISMATCH', `precompiled plan version ${String(value.version ?? 0)} is not supported`);
    if (value.schema_hash !== this.schemaHash) throw new OrmError('SCHEMA_HASH_MISMATCH', `precompiled plan schema ${String(value.schema_hash ?? '')} but client schema is ${this.schemaHash}`);
    if (request.schema_hash !== this.schemaHash) throw new OrmError('SCHEMA_HASH_MISMATCH', `request schema ${request.schema_hash} but client schema is ${this.schemaHash}`);
    if (value.dialect !== this.driver) throw new OrmError('CONFIG', `precompiled plan dialect ${String(value.dialect ?? '')} but database driver is ${this.driver}`);
    if (typeof value.request_sha256 !== 'string' || value.request_sha256 === '') throw new OrmError('CONFIG', 'precompiled plan requires request_sha256');
    const requestHash = createHash('sha256').update(canonical(request)).digest('hex');
    if (requestHash !== value.request_sha256) throw new OrmError('CONFIG', `precompiled plan request hash ${value.request_sha256} does not match request shape ${requestHash}`);
    const plan = value.plan as Plan | undefined;
    if (plan === undefined || typeof plan !== 'object' || plan.schema_hash !== this.schemaHash || plan.kind !== request.kind || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new OrmError('CONFIG', 'precompiled plan body does not match its envelope or request');
    }
    const key = canonical(request);
    this.plans.set(key, plan);
    this.planOrder.push(key);
    while (this.planOrder.length > this.planCacheSize) {
      const oldest = this.planOrder.shift();
      if (oldest !== undefined) this.plans.delete(oldest);
    }
  }

  public async execute(plan: Plan, params: Param[]): Promise<unknown> {
    if (plan.schema_hash !== this.schemaHash) throw new OrmError('SCHEMA_HASH_MISMATCH', `plan schema ${plan.schema_hash} but client schema is ${this.schemaHash}`);
    if (plan.steps.length === 0) throw new OrmError('INTERNAL', 'plan has no steps');
    switch (plan.kind) {
      case 'one': {
        const rows = await this.select(plan, params);
        return rowCollection(rows, requiredAssemble(plan.steps[0])).first() ?? null;
      }
      case 'all':
      case 'group_count': {
        const rows = await this.select(plan, params);
        return rowCollection(rows, requiredAssemble(plan.steps[0]));
      }
      case 'paginate': {
        const rows = await this.select(plan, params);
        const count = await this.scalar(plan.steps.find(step => step.role === 'count')!, params);
        return { rows: rowCollection(rows, requiredAssemble(plan.steps[0])), total: Number(count) };
      }
      case 'count': case 'count_distinct': case 'sum': case 'avg': case 'min': case 'max':
        return this.scalar(plan.steps[0], params);
      case 'raw': {
        const result = await this.run(plan.steps[0], params);
        return result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
      }
      case 'insert': case 'update': case 'delete':
        return this.write(plan.steps[0], params, plan.kind === 'insert');
    }
  }

  public async stream<T extends Row>(plan: Plan, params: Param[], visit: (row: T) => boolean | Promise<boolean>): Promise<StreamResult> {
    if (plan.schema_hash !== this.schemaHash) throw new OrmError('SCHEMA_HASH_MISMATCH', `plan schema ${plan.schema_hash} but client schema is ${this.schemaHash}`);
    if (plan.steps.slice(1).some(step => step.role === 'relation')) throw new OrmError('IR_INVALID', 'stream does not support separate relation steps; use a join or gets');
    const step = plan.steps[0];
    if (!step) throw new OrmError('INTERNAL', 'plan has no steps');
    const assemble = requiredAssemble(step);
    const binds = this.binds(step, params, []);
    const rows = new ExecutionRows(this, plan, params, []);
    const started = performance.now();
    try {
      const result = await this.connection.stream(step.sql, binds as DriverValue[], async values => {
        decodeAssembly(values, assemble, this.aesKey, this.aesKeyring);
        return visit(rowFromResult<T>(rows, assemble, values));
      });
      this.onQuery?.({ sql: step.sql, binds: maskBinds(step, binds), seconds: (performance.now() - started) / 1000 });
      return { state: result.exhausted ? 'exhausted' : 'stopped', count: result.count };
    } catch (error) {
      this.onQuery?.({ sql: step.sql, binds: maskBinds(step, binds), seconds: (performance.now() - started) / 1000, error });
      throw error;
    }
  }

  public async sql(step: PlanStep, params: readonly Param[]): Promise<{ sql: string; binds: unknown[] }> {
    return { sql: step.sql, binds: this.binds(step, params, [], true) };
  }

  private async select(plan: Plan, params: readonly Param[]): Promise<ExecutionRows> {
    const main = plan.steps[0]!;
    const result = await this.run(main, params);
    decodeRows(result.rows, requiredAssemble(main), this.aesKey, this.aesKeyring);
    const rows = new ExecutionRows(this, plan, params, result.rows);
    for (const step of plan.steps) {
      if (step.role !== 'relation') continue;
      if (!step.parent) throw new OrmError('INTERNAL', `relation step ${step.id} has no parent reference`);
      const parents = step.parent.step === 0 ? rows.data : rows['steps'].get(step.parent.step)?.data ?? [];
      const values = parentValues(step, parents, params);
      if (values.length === 0) { rows.setStep(step.id, [], childKeys(plan, step.id)); continue; }
      const collected: unknown[][] = [];
      for (const chunk of relationChunks(step, values, this.connection.name)) {
        const expanded = expandParent(step, chunk);
        const result = await this.run(step, params, expanded.sql, expanded.values);
        decodeRows(result.rows, requiredAssemble(step), this.aesKey, this.aesKeyring);
        collected.push(...result.rows);
      }
      rows.setStep(step.id, collected, childKeys(plan, step.id));
    }
    return rows;
  }

  private async scalar(step: PlanStep, params: readonly Param[]): Promise<unknown> {
    return (await this.run(step, params)).rows[0]?.[0] ?? null;
  }

  private async write(step: PlanStep, params: readonly Param[], insert: boolean): Promise<{ affected: number; insertId: unknown }> {
    const result = await this.run(step, params);
    return { affected: result.affected || (insert && result.rows.length ? 1 : 0), insertId: insert ? result.insertId : null };
  }

  private async run(step: PlanStep, params: readonly Param[], sql = step.sql, parents: readonly Param[] = []) {
    const binds = this.binds(step, params, parents);
    const started = performance.now();
    try {
      const result = await this.connection.execute(sql, binds as DriverValue[]);
      this.onQuery?.({ sql, binds: maskBinds(step, binds), seconds: (performance.now() - started) / 1000 });
      return result;
    } catch (error) {
      this.onQuery?.({ sql, binds: maskBinds(step, binds), seconds: (performance.now() - started) / 1000, error });
      throw error;
    }
  }

  private binds(step: PlanStep, params: readonly Param[], parents: readonly Param[], dump = false): unknown[] {
    const out: unknown[] = [];
    for (const slot of step.bind_slots) {
      switch (slot.from) {
        case 'parent': out.push(...parents); break;
        case 'param': {
          let value = params[slot.param];
          if (slot.transform) value = transform(slot.transform, String(value));
          if (slot.host_styles.includes('blind_index')) {
            if (slot.host_styles.length !== 1) throw new OrmError('CONFIG', 'blind_index must be the only host style');
            value = blindIndex(value, this.blindIndexKey);
          } else if (slot.host_styles.length > 0) value = hostEncode(value, slot.host_styles, this.aesKey);
          if (slot.col_type === 'point' && value !== null) value = this.driver === 'postgres' ? postgresPoint(value) : pointText(parsePoint(value as string));
          if (this.driver === 'sqlite' && value instanceof Date) value = sqlDate(value);
          if (this.driver === 'postgres' && value instanceof Date) value = sqlDate(value).replace(/\.000000$/, '');
          out.push(value);
          break;
        }
        case 'secret':
          if (dump) out.push('$SECRET');
          else if (slot.name === 'aes' && this.aesKey !== '') out.push(this.aesKey);
          else throw new OrmError('CONFIG', `secret ${slot.name} not configured`);
          break;
        case 'config':
          if (slot.name === 'aes_version') out.push(this.aesVersion);
          else throw new OrmError('CONFIG', `config value ${slot.name} not configured`);
          break;
        case 'now': out.push(dump ? '$NOW' : sqlDate(new Date())); break;
        default: throw new OrmError('INTERNAL', `bind from ${slot.from}`);
      }
    }
    return out;
  }
}

export class Tx extends Db {
  public active: boolean = true;
  public constructor(private readonly transactionConnection: DriverTransaction, outer: Db) {
    super(transactionConnection, { schemaHash: outer.schemaHash, compiler: transportUnavailable, aesKey: outer['aesKey'], blindIndexKey: outer['blindIndexKey'], aesVersion: outer['aesVersion'], aesKeys: outer['aesKeyring']?.keyMap(), onQuery: outer['onQuery'] }, outer);
    this.compiler = outer.compiler;
  }
  public override readonly compiler: Compiler;
  public async commit(): Promise<void> { this.assertActive(); await this.transactionConnection.commit(); this.active = false; }
  public async rollback(): Promise<void> { this.assertActive(); await this.transactionConnection.rollback(); this.active = false; }
  public async savepoint(name: string): Promise<void> { this.assertActive(); await this.transactionConnection.savepoint(name); }
  public async rollbackTo(name: string): Promise<void> { this.assertActive(); await this.transactionConnection.rollbackTo(name); }
  public async releaseSavepoint(name: string): Promise<void> { this.assertActive(); await this.transactionConnection.releaseSavepoint(name); }
  public override async execute(plan: Plan, params: Param[]): Promise<unknown> { this.assertActive(); return super.execute(plan, params); }
  private assertActive(): void { if (!this.active) throw new OrmError('CONFIG', 'transaction already finished'); }
}

const transportUnavailable: CompilerTransport = {
  compile: async () => { throw new OrmError('INTERNAL', 'transaction compiler placeholder used'); },
  metadata: async () => { throw new OrmError('INTERNAL', 'transaction compiler placeholder used'); },
};

function requiredAssemble(step: PlanStep) { if (!step.assemble) throw new OrmError('INTERNAL', `step ${step.id} has no assembly`); return step.assemble; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
function transform(kind: string, value: string): string { const escaped = value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_'); if (kind === 'fulltext_boolean') return value.trim() === '' ? '' : `+${value.trim().replaceAll(' ', ' +')}*`; if (kind === 'like_contains') return `%${escaped}%`; if (kind === 'like_starts') return `${escaped}%`; if (kind === 'like_ends') return `%${escaped}`; return value; }
function sqlDate(value: Date): string { return value.toISOString().replace('T', ' ').replace('Z', '').replace(/\.([0-9]{3})$/, '.$1000'); }
function postgresPoint(value: unknown): string { const [x,y] = parsePoint(value as string); return `(${x},${y})`; }
function maskBinds(step: PlanStep, binds: readonly unknown[]): unknown[] { const out: unknown[]=[]; let index=0; for (const slot of step.bind_slots) { if(slot.from==='parent') { while(index<binds.length-step.bind_slots.length+1) out.push(binds[index++]); } else { out.push(slot.from==='secret'?'$SECRET':slot.from==='now'?'$NOW':binds[index]); index++; } } return out.length===binds.length?out:[...binds]; }
function decodeRows(rows: unknown[][], assemble: ReturnType<typeof requiredAssemble>, aesKey: string, keyring?: AesKeyring): void { for (const row of rows) decodeAssembly(row, assemble, aesKey, keyring); }
function decodeAssembly(row: unknown[], assemble: ReturnType<typeof requiredAssemble>, aesKey: string, keyring?: AesKeyring): void {
  let version = keyring?.currentVersion ?? 1;
  for (const column of assemble.columns) if (column.hidden && column.column === 'aes_key_version') version = Number(row[column.index]);
  for (const column of assemble.columns) {
    let value = row[column.index];
    if (value !== null && column.styles.length) {
      const host = column.styles.filter(style => style === 'aes' || style === 'hex' || style === 'ip');
      const app = column.styles.filter(style => !host.some(value => value === style));
      if (host.length) value = hostDecode(value as string | Uint8Array, host, host.includes('aes') ? keyring?.key(version) ?? aesKey : aesKey);
      if (app.length) value = decode(app, value as string | Uint8Array);
    }
    if (value !== null && column.type === 'string' && value instanceof Uint8Array) {
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(value); }
      catch (error) { throw new OrmError('CODEC_DECODE', `${assemble.entity}.${column.name}: invalid UTF-8 string: ${String(error)}`); }
    } else if (value !== null && column.type === 'bool') {
      value = value === true || value === 1 || value === '1' || value === 't';
    } else if (value !== null && ['i32', 'i64', 'f64', 'decimal'].includes(column.type)) {
      value = Number(value);
    }
    row[column.index] = value;
  }
  for (const child of assemble.children) if (child.kind === 'join' && child.assemble) decodeAssembly(row, child.assemble, aesKey, keyring);
}
function parentValues(step: PlanStep, parents: unknown[][], params: readonly Param[]): Param[] { const ref=step.parent!; const seen=new Set<string>(); const out:Param[]=[]; for(const row of parents){if(ref.if_parent&&scalarKey(row[ref.if_parent.index])!==scalarKey(params[ref.if_parent.param]))continue;const key=rowKey(row,ref.keys);if(key===undefined||seen.has(key))continue;seen.add(key);for(const part of ref.keys)out.push(row[part.index] as Param);}return out; }
function expandParent(step: PlanStep, source: Param[]): {sql:string;values:Param[]} { const width=step.parent?.keys.length??0;if(width===0||source.length%width!==0)throw new OrmError('INTERNAL',`relation step ${step.id} has invalid parent keys`);const tuples=source.length/width;let size=1;while(size<tuples)size<<=1;const values=[...source];while(values.length<size*width)values.push(...source.slice((tuples-1)*width,tuples*width));const replacement=(start:number,format:(n:number)=>string)=>Array.from({length:size},(_,tuple)=>Array.from({length:width},(_,part)=>format(start+tuple*width+part)).join(', ')).join(width===1?', ': '), (');const parentSlot=step.bind_slots.findIndex(slot=>slot.from==='parent');if(parentSlot<0)throw new OrmError('INTERNAL',`relation step ${step.id} has no parent bind`);if(step.sql.includes('$1')){const parent=parentSlot+1;return{sql:step.sql.replace(/\$(\d+)/g,(_,raw)=>{const n=Number(raw);if(n===parent)return replacement(n,i=>`$${i}`);return `$${n>parent?n+size*width-1:n}`;}),values};}let slot=0;return{sql:step.sql.replace(/\?/g,()=>step.bind_slots[slot++]?.from==='parent'?replacement(0,()=>'?'):'?'),values}; }
function relationChunks(step: PlanStep, values: Param[], driver: string): Param[][] { const width=step.parent?.keys.length??0;if(width===0||values.length%width!==0)throw new OrmError('IR_INVALID',`relation step ${step.id} has invalid parent keys`);const nonParent=step.bind_slots.filter(slot=>slot.from!=='parent').length;const limit=driver==='sqlite'?999:65535;const max=Math.floor((limit-nonParent)/width);if(max<1)throw new OrmError('IR_INVALID',`relation step ${step.id} needs ${nonParent+width} bind parameters but ${driver} permits ${limit}`);let size=1;while(size*2<=max)size*=2;const tuples=values.length/width;const out:Param[][]=[];for(let start=0;start<tuples;start+=size)out.push(values.slice(start*width,Math.min(start+size,tuples)*width));return out; }
function childKeys(plan: Plan,id:number):import('./index.js').KeyReference[] { const find=(assemble:ReturnType<typeof requiredAssemble>):import('./index.js').KeyReference[]|undefined=>{for(const child of assemble.children){if(child.kind!=='join'&&child.step===id)return child.child_keys;if(child.assemble){const found=find(child.assemble);if(found)return found;}}};for(const step of plan.steps)if(step.assemble){const found=find(step.assemble);if(found)return found;}throw new OrmError('INTERNAL',`relation step ${id} has no child attachment`); }
