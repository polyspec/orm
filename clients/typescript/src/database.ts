import type { Compiler, Database, Executor, Param, Plan, PlanStep, Request } from './index.js';
import { ConnectCompiler, ConnectPlanCompiler, type CompilerTransport } from './compiler.js';
import { decode, encode, parsePoint, pointText, type CodecValue } from './codec.js';
import type { DriverConnection, DriverTransaction, DriverValue } from './driver.js';
import { openMySql, openPostgres, openSqlite } from './driver.js';
import { ExecutionRows, Page, rowCollection, scalarKey } from './model.js';
import { OrmError } from './runtime_error.js';

export interface QueryEvent { sql: string; binds: readonly unknown[]; seconds: number; error?: unknown; }
export interface DatabaseOptions {
  schemaHash: string;
  compiler: CompilerTransport;
  aesKey?: string;
  onQuery?: (event: QueryEvent) => void;
}

export class Db implements Database, Executor {
  public readonly compiler: Compiler;
  public readonly schemaHash: string;
  private readonly plans = new Map<string, Plan>();
  public constructor(
    protected readonly connection: DriverConnection,
    options: DatabaseOptions,
    protected readonly root: Db | undefined = undefined,
  ) {
    this.schemaHash = options.schemaHash;
    this.compiler = new ConnectPlanCompiler(options.compiler);
    this.aesKey = options.aesKey ?? '';
    this.onQuery = options.onQuery;
  }
  protected readonly aesKey: string;
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
  public static mysql(uri: string, options: DatabaseOptions): Promise<Db> { return Db.connect(openMySql(uri), options); }
  public static postgres(uri: string, options: DatabaseOptions): Promise<Db> { return Db.connect(openPostgres(uri), options); }
  public static sqlite(path: string, options: DatabaseOptions): Promise<Db> { return Db.connect(openSqlite(path), options); }

  public async close(): Promise<void> { await this.connection.close(); }
  public async transaction<T>(callback: (transaction: Tx) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const connection = await this.connection.begin();
      const transaction = new Tx(connection, this);
      try {
        const result = await callback(transaction);
        await transaction.commit();
        return result;
      } catch (error) {
        if (transaction.active) await transaction.rollback();
        if (!(error instanceof OrmError) || error.code !== 'DEADLOCK') throw error;
        last = error;
        await new Promise(resolve => setTimeout(resolve, (50 << attempt) + Math.floor(Math.random() * 20)));
      }
    }
    throw last;
  }

  public async plan(request: Request): Promise<Plan> {
    const key = canonical(request);
    const cached = this.plans.get(key);
    if (cached) return cached;
    const plan = await this.compiler.compile(request);
    this.plans.set(key, plan);
    return plan;
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
        return { rows, total: Number(count) };
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

  public async sql(step: PlanStep, params: readonly Param[]): Promise<{ sql: string; binds: unknown[] }> {
    return { sql: step.sql, binds: this.binds(step, params, [], true) };
  }

  private async select(plan: Plan, params: readonly Param[]): Promise<ExecutionRows> {
    const main = plan.steps[0]!;
    const result = await this.run(main, params);
    decodeRows(result.rows, requiredAssemble(main));
    const rows = new ExecutionRows(this, plan, params, result.rows);
    for (const step of plan.steps) {
      if (step.role !== 'relation') continue;
      if (!step.parent) throw new OrmError('INTERNAL', `relation step ${step.id} has no parent reference`);
      const parents = step.parent.step === 0 ? rows.data : rows['steps'].get(step.parent.step)?.data ?? [];
      const values = parentValues(step, parents, params);
      if (values.length === 0) { rows.setStep(step.id, [], childIndex(plan, step.id)); continue; }
      const expanded = expandParent(step, values);
      const result = await this.run(step, params, expanded.sql, expanded.values);
      decodeRows(result.rows, requiredAssemble(step));
      rows.setStep(step.id, result.rows, childIndex(plan, step.id));
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
          if (slot.host_styles.length > 0) value = hostEncode(value, slot.host_styles, this.aesKey);
          if (slot.col_type === 'point' && value !== null) value = this.driver === 'postgres' ? postgresPoint(value) : pointText(parsePoint(value as string));
          if (this.driver === 'sqlite' && value instanceof Date) value = sqlDate(value);
          out.push(value);
          break;
        }
        case 'secret':
          if (dump) out.push('$SECRET');
          else if (slot.name !== 'aes' || this.aesKey === '') throw new OrmError('CONFIG', `secret ${slot.name} not configured`);
          else out.push(this.aesKey);
          break;
        case 'now': out.push(dump ? '$NOW' : sqlDate(new Date())); break;
        default: throw new OrmError('INTERNAL', `bind from ${slot.from}`);
      }
    }
    return out;
  }
}

export class Tx extends Db {
  public active = true;
  public constructor(private readonly transactionConnection: DriverTransaction, outer: Db) {
    super(transactionConnection, { schemaHash: outer.schemaHash, compiler: transportUnavailable, aesKey: outer['aesKey'], onQuery: outer['onQuery'] }, outer);
    this.compiler = outer.compiler;
  }
  public override readonly compiler: Compiler;
  public async commit(): Promise<void> { this.assertActive(); await this.transactionConnection.commit(); this.active = false; }
  public async rollback(): Promise<void> { this.assertActive(); await this.transactionConnection.rollback(); this.active = false; }
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
function hostEncode(value: unknown, styles: readonly string[], _key: string): unknown { if (value === null) return null; if (styles.some(style => style === 'aes' || style === 'ip')) throw new OrmError('CODEC_UNSUPPORTED', `host styles ${styles.join(',')} require the TypeScript cryptographic codec`); if (styles.length === 1 && styles[0] === 'hex') return Buffer.from(String(value)).toString('hex').toUpperCase(); throw new OrmError('CODEC_UNSUPPORTED', `host styles ${styles.join(',')}`); }
function maskBinds(step: PlanStep, binds: readonly unknown[]): unknown[] { const out: unknown[]=[]; let index=0; for (const slot of step.bind_slots) { if(slot.from==='parent') { while(index<binds.length-step.bind_slots.length+1) out.push(binds[index++]); } else { out.push(slot.from==='secret'?'$SECRET':slot.from==='now'?'$NOW':binds[index]); index++; } } return out.length===binds.length?out:[...binds]; }
function decodeRows(rows: unknown[][], assemble: ReturnType<typeof requiredAssemble>): void { for (const row of rows) decodeAssembly(row, assemble); }
function decodeAssembly(row: unknown[], assemble: ReturnType<typeof requiredAssemble>): void { for (const column of assemble.columns) { let value=row[column.index]; if(value!==null && column.styles.length) value=decode(column.styles, value as string|Uint8Array); if(value!==null && column.type==='bool') value=value===true||value===1||value==='1'||value==='t'; else if(value!==null && ['i32','i64','f64','decimal'].includes(column.type)) value=Number(value); row[column.index]=value; } for(const child of assemble.children) if(child.kind==='join'&&child.assemble) decodeAssembly(row,child.assemble); }
function parentValues(step: PlanStep, parents: unknown[][], params: readonly Param[]): Param[] { const ref=step.parent!; const seen=new Set<string>(); const out:Param[]=[]; for(const row of parents){if(ref.if_parent&&scalarKey(row[ref.if_parent.index])!==scalarKey(params[ref.if_parent.param]))continue;const value=row[ref.index];if(value===null)continue;const key=scalarKey(value);if(seen.has(key))continue;seen.add(key);out.push(value);}return out; }
function expandParent(step: PlanStep, source: Param[]): {sql:string;values:Param[]} { let size=1;while(size<source.length)size<<=1;const values=[...source];while(values.length<size)values.push(values[values.length-1]);const parentSlot=step.bind_slots.findIndex(slot=>slot.from==='parent');if(parentSlot<0)throw new OrmError('INTERNAL',`relation step ${step.id} has no parent bind`);if(step.sql.includes('$1')){const parent=parentSlot+1;return{sql:step.sql.replace(/\$(\d+)/g,(_,raw)=>{const n=Number(raw);if(n===parent)return Array.from({length:size},(_,i)=>`$${n+i}`).join(', ');return `$${n>parent?n+size-1:n}`;}),values};}let slot=0;return{sql:step.sql.replace(/\?/g,()=>step.bind_slots[slot++]?.from==='parent'?Array(size).fill('?').join(', '):'?'),values}; }
function childIndex(plan: Plan,id:number):number { const find=(assemble:ReturnType<typeof requiredAssemble>):number|undefined=>{for(const child of assemble.children){if(child.kind!=='join'&&child.step===id)return child.child_index;if(child.assemble){const found=find(child.assemble);if(found!==undefined)return found;}}};for(const step of plan.steps)if(step.assemble){const found=find(step.assemble);if(found!==undefined)return found;}throw new OrmError('INTERNAL',`relation step ${id} has no child attachment`); }
