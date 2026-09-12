export type Param = unknown;

export { CodecError, blindIndex, decode as decodeCodec, encode as encodeCodec, hostDecode, hostEncode, parsePoint, pointText } from './codec.js';
export type { CodecValue, EncodedValue, Point, UploadFileValue } from './codec.js';

export interface AesRotationColumn {
  name: string;
  styles: readonly string[];
}

export interface AesRotationSpec {
  table: string;
  primaryKeys: readonly string[];
  versionColumn: string;
  columns: readonly AesRotationColumn[];
  batchSize?: number;
}

export interface AesRotationStatus {
  current: number;
  total: number;
  pending: number;
  versions: Readonly<Record<string, number>>;
}

export interface StreamResult {
  state: 'exhausted' | 'stopped';
  count: number;
}

export interface TransactionOptions {
  retryDeadlocks?: boolean;
  maxAttempts?: number;
  isolation?: 'default' | 'read_uncommitted' | 'read_committed' | 'repeatable_read' | 'serializable';
  readOnly?: boolean;
}

export interface BatchOptions { chunkSize?: number; }

export interface BatchResult { attempted: number; affected: number; inserted: number; }

export interface BatchRequest { plan: Plan; params: readonly Param[]; }

export interface AesRowCodec {
  decode(value: unknown, styles: readonly string[], key: string): unknown;
  encode(value: unknown, styles: readonly string[], key: string): unknown;
}

export class AesKeyring {
  private readonly keys: ReadonlyMap<number, string>;
  public constructor(keys: ReadonlyMap<number, string>, public readonly currentVersion: number) {
    if (currentVersion < 1 || !keys.has(currentVersion)) throw new Error(`AES version ${currentVersion} is not declared`);
    for (const [version, key] of keys) {
      if (version < 1 || key.length === 0) throw new Error(`AES version ${version} has no key`);
    }
    this.keys = new Map(keys);
  }

  public versions(): number[] { return [...this.keys.keys()].sort((a, b) => a - b); }

  public key(version: number): string {
    const key = this.keys.get(version);
    if (key === undefined) throw new Error(`AES version ${version} is not declared`);
    return key;
  }

  public keyMap(): ReadonlyMap<number, string> { return new Map(this.keys); }

  public rotateRow(
    row: Readonly<Record<string, unknown>>,
    versionColumn: string,
    columns: readonly AesRotationColumn[],
    targetVersion: number,
    codec: AesRowCodec,
  ): Record<string, unknown> {
    const oldVersion = row[versionColumn];
    if (typeof oldVersion !== 'number' || !Number.isInteger(oldVersion)) throw new Error('AES row version must be an integer');
    const oldKey = this.keys.get(oldVersion);
    const newKey = this.keys.get(targetVersion);
    if (oldKey === undefined) throw new Error(`AES version ${oldVersion} is not declared`);
    if (newKey === undefined) throw new Error(`AES target version ${targetVersion} is not declared`);
    const out = { ...row };
    for (const column of columns) {
      if (!(column.name in row)) throw new Error(`AES column ${column.name} is missing`);
      const plain = codec.decode(row[column.name], column.styles, oldKey);
      out[column.name] = codec.encode(plain, column.styles, newKey);
    }
    out[versionColumn] = targetVersion;
    return out;
  }
}

export type QueryKind = 'one' | 'all' | 'count' | 'group_count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max' | 'paginate' | 'insert' | 'update' | 'delete' | 'raw';

export interface RequestQuery {
  entity: string;
  scope_p?: number;
  columns?: Projection;
  on?: Group;
  where?: Group;
  having?: Group;
  joins?: Join[];
  relations?: Relation[];
  order?: Order[];
  group_by?: string[];
  group_by_expr?: GroupExpression[];
  limit?: Limit;
  distinct?: boolean;
  force_index?: string;
  lock?: 'update' | 'share';
  keyset?: Keyset;
  key_by?: string;
  flatten?: boolean;
  limit_per_parent?: number;
  if_parent?: IfParent;
  drop_child_key?: boolean;
  no_cascade_delete?: boolean;
}

export interface Keyset {
  direction: 'after' | 'before';
  values: number[];
}

export interface Request extends RequestQuery {
  ir_version: 1;
  schema_hash: string;
  kind: QueryKind;
  set?: Assignment[];
  on_duplicate?: Assignment[];
  optimistic?: Optimistic;
  raw?: Raw;
  agg?: string;
  debug?: boolean;
  n_params: number;
}

export interface Group {
  conn?: string;
  items: Item[];
}

export interface Item {
  pred?: Predicate;
  group?: Group;
  nav?: Navigation;
}

export interface ColumnReferenceIR { path: string; column: string; }
export interface Predicate {
  conn?: string;
  column?: string;
  op?: string;
  p?: number;
  ps?: number[];
  ref?: ColumnReferenceIR;
  expr?: string;
  match?: string[];
}

export interface Navigation { conn?: string; rel: string; group: Group; mode?: '' | 'exists' | 'not_exists'; }
export interface Projection { mode?: '' | 'all' | 'none'; add?: string[]; remove?: string[]; as?: Record<string,string>; expr?: Record<string,string>; }
export interface Order { column?: string; expr?: string; desc?: boolean; }
export interface GroupExpression { expr: string; as: string; }
export interface Limit { offset: number; count: number; }
export interface IfParent { column: string; p: number; }
export interface Assignment { column: string; p?: number; null?: boolean; expr?: string; ps?: number[]; plus_p?: number; minus_p?: number; }
export interface Optimistic { column: string; p: number; }
export interface Raw { sql: string; ps?: number[]; }

export interface Relation {
  rel: string;
  query: RequestQuery;
}

export interface Join {
  rel: string;
  kind: 'inner' | 'left';
  query: RequestQuery;
}

export interface Plan {
  schema_hash: string;
  kind: QueryKind;
  steps: PlanStep[];
}

export interface PlanStep { id:number; role:string; sql:string; bind_slots:BindSlot[]; assemble?:Assemble; parent?:ParentReference; }
export interface BindSlot { from:string; param:number; transform:string; name:string; step:number; column:string; host_styles:string[]; col_type:string; }
export interface PlanIfParent { column:string; index:number; param:number; }
export interface KeyReference { column:string; index:number; }
export interface ParentReference { step:number; keys:KeyReference[]; if_parent?:PlanIfParent; }
export interface Assemble { entity:string; alias:string; columns:OutputColumn[]; children:Child[]; key:KeyReference[]; }
export interface OutputColumn { index:number; name:string; column:string; type:string; styles:string[]; hidden:boolean; }
export interface Child { rel:string; kind:string; step:number; parent_keys:KeyReference[]; child_keys:KeyReference[]; key:KeyReference[]; flatten:boolean; cascade:boolean; assemble?:Assemble; }

export interface Compiler {
  compile(request: Request): Promise<Plan>;
}

export interface Executor {
  execute(plan: Plan, params: Param[]): Promise<unknown>;
}

export interface Database {
  compiler: Compiler;
  executor: Executor;
  schemaHash: string;
}

export { CompilerError, ConnectCompiler, ConnectPlanCompiler, compileRequest } from './compiler.js';
export { planFromProto, requestToProto } from './compiler_bridge.js';
export type { CompilerTransport } from './compiler.js';
export { openMySql, openPostgres, openSqlite } from './driver.js';
export type { DriverConnection, DriverName, DriverResult, DriverStreamResult, DriverTransaction, DriverValue } from './driver.js';
export { OrmError } from './runtime_error.js';
export { Db, Tx, batchWrite } from './database.js';
export type { DatabaseOptions, QueryEvent } from './database.js';
export { loadConfig, resolveAesKey, resolveBlindIndexKey } from './config.js';
export type { FileConfig } from './config.js';
export { Collection, ExecutionRows, KeysetPage, Page, Row, keysetPage, registerRow, rowFromResult } from './model.js';
export { decodeKeysetCursor, encodeKeysetCursor } from './keyset.js';
export { Binding, ColumnReference, QueryCore, RequestState, WhereCore } from './builder.js';
export * from './gen/entities.js';
export type { Key, RowConstructor } from './model.js';
export * as CompilerProto from './gen/proto/orm/compiler/v1/compiler_pb.js';
