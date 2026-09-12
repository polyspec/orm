export type Param = unknown;
type Terminal = 'get' | 'gets' | 'count';

export { CodecError, decode as decodeCodec, encode as encodeCodec, parsePoint, pointText } from './codec.js';
export type { CodecValue, EncodedValue, Point, UploadFileValue } from './codec.js';

export interface AesRotationColumn {
  name: string;
  styles: readonly string[];
}

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

export interface Request {
  ir_version: 1;
  schema_hash: string;
  kind: QueryKind;
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
  key_by?: string;
  flatten?: boolean;
  limit_per_parent?: number;
  if_parent?: IfParent;
  drop_child_key?: boolean;
  no_cascade_delete?: boolean;
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

export interface Predicate {
  conn?: string;
  column?: string;
  op?: string;
  p?: number;
  ps?: number[];
  ref?: { path: string; column: string };
  expr?: string;
  match?: string[];
}

export interface Navigation { conn?: string; rel: string; group: Group; }
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

export type RequestQuery = Omit<Request, 'ir_version'|'schema_hash'|'kind'|'set'|'on_duplicate'|'optimistic'|'raw'|'agg'|'debug'|'n_params'>;

export interface Plan {
  schema_hash: string;
  kind: QueryKind;
  steps: PlanStep[];
}

export interface PlanStep { id:number; role:string; sql:string; bind_slots:BindSlot[]; assemble?:Assemble; parent?:ParentReference; }
export interface BindSlot { from:string; param:number; transform:string; name:string; step:number; column:string; host_styles:string[]; col_type:string; }
export interface ParentReference { step:number; column:string; index:number; if_parent?:{column:string;index:number;param:number}; }
export interface Assemble { entity:string; alias:string; columns:OutputColumn[]; children:Child[]; }
export interface OutputColumn { index:number; name:string; column:string; type:string; styles:string[]; hidden:boolean; }
export interface Child { rel:string; kind:string; step:number; parent_column:string; parent_index:number; child_column:string; child_index:number; key_by:string; key_index:number; flatten:boolean; cascade:boolean; assemble?:Assemble; }

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

export interface BattleRow {
  seq: number;
  name: string;
  service_seq: number;
  is_close: boolean;
  is_display: boolean;
  is_allday: boolean;
  user?: unknown;
}

export class Where {
  public constructor(
    private readonly group: Group,
    private readonly params: Param[],
  ) {}

  public or(): this {
    this.pendingOr = true;
    return this;
  }

  public serviceSeqEq(value: number): this { return this.eq('service_seq', value); }
  public isCloseEq(value: boolean): this { return this.eq('is_close', value); }
  public isDisplayEq(value: boolean): this { return this.eq('is_display', value); }
  public isAlldayEq(value: boolean): this { return this.eq('is_allday', value); }
  public seqIn(values: readonly number[]): this { return this.in('seq', values); }
  public name(value: string): this { return this.eq('name', value); }
  public and(callback: (where: Where) => void): this {
    const group: Group = { items: [] };
    this.group.items.push({ group });
    callback(new Where(group, this.params));
    return this;
  }

  private pendingOr = false;

  private eq(column: string, value: Param): this {
    const p = this.params.push(value) - 1;
    const item: Item = { pred: { column, op: 'eq', p } };
    if (this.pendingOr) item.pred!.conn = 'or';
    this.pendingOr = false;
    this.group.items.push(item);
    return this;
  }

  private in(column: string, values: readonly Param[]): this {
    const ps = values.map(value => this.params.push(value) - 1);
    this.group.items.push({ pred: { column, op: 'in', ps } });
    return this;
  }
}

export class BattleQuery {
  private readonly request: Request;
  private readonly params: Param[] = [];
  private database?: Database;

  public constructor(entity = 'battle') {
    this.request = {
      ir_version: 1,
      schema_hash: '',
      kind: 'all',
      entity,
      n_params: 0,
    };
  }

  public using(database: Database): this {
    this.database = database;
    this.request.schema_hash = database.schemaHash;
    return this;
  }

  public serviceSeqEq(value: number): this { return this.condition('service_seq', value); }
  public scope(value: number): this {
    if (this.request.entity !== 'battle') throw new Error(`scope is not declared for ${this.request.entity}`);
    this.request.scope_p = this.params.push(value) - 1;
    return this;
  }
  public isCloseEq(value: boolean): this { return this.condition('is_close', value); }
  public isDisplayEq(value: boolean): this { return this.condition('is_display', value); }
  public isAlldayEq(value: boolean): this { return this.condition('is_allday', value); }
  public seqIn(values: readonly number[]): this { return this.in('seq', values); }
  public name(value: string): this { return this.condition('name', value); }

  public and(callback: (where: Where) => void): this {
    const group: Group = { items: [] };
    this.where().items.push({ group });
    callback(new Where(group, this.params));
    return this;
  }

  public or(): this {
    this.pendingOr = true;
    return this;
  }

  public relation(rel: string, callback?: (where: Where) => void): this {
    const query: { entity: string; where?: Group } = { entity: rel };
    if (callback) {
      query.where = { items: [] };
      callback(new Where(query.where, this.params));
    }
    this.request.joins = [...(this.request.joins ?? []), { rel, kind: 'inner', query }];
    return this;
  }

  public join(rel: string, callback?: (where: Where) => void): this { return this.relation(rel, callback); }

  public get(): Promise<BattleRow | null> {
    return this.execute('get') as Promise<BattleRow | null>;
  }

  public gets(): Promise<BattleRow[]> {
    return this.execute('gets') as Promise<BattleRow[]>;
  }

  public getCount(): Promise<number> {
    return this.execute('count') as Promise<number>;
  }

  public requestShape(): Request { return structuredClone(this.request); }
  public parameters(): Param[] { return [...this.params]; }

  private pendingOr = false;

  private where(): Group {
    this.request.where ??= { items: [] };
    return this.request.where;
  }

  private condition(column: string, value: Param): this {
    const p = this.params.push(value) - 1;
    const pred: Predicate = { column, op: 'eq', p };
    if (this.pendingOr) pred.conn = 'or';
    this.pendingOr = false;
    this.where().items.push({ pred });
    return this;
  }

  private in(column: string, values: readonly Param[]): this {
    const ps = values.map(value => this.params.push(value) - 1);
    this.where().items.push({ pred: { column, op: 'in', ps } });
    return this;
  }

  private async execute(kind: Terminal): Promise<unknown> {
    if (!this.database) throw new Error('database is not configured');
    this.request.kind = kind === 'count' ? 'count' : 'all';
    this.request.n_params = this.params.length;
    const plan = await this.database.compiler.compile(this.requestShape());
    return this.database.executor.execute(plan, [...this.params]);
  }
}

export function Battle(): BattleQuery { return new BattleQuery(); }

// Generated entity entry points. The current TypeScript client shares the
// request, relation, terminal, and execution order with the other clients.
export class UserQuery extends BattleQuery {
  public constructor() { super('user'); }
}
export class ServiceQuery extends BattleQuery {
  public constructor() { super('service'); }
}
export class ServiceModuleQuery extends BattleQuery {
  public constructor() { super('service_module'); }
}
export class ServiceMemberQuery extends BattleQuery {
  public constructor() { super('service_member'); }
}

export function User(): UserQuery { return new UserQuery(); }
export function Service(): ServiceQuery { return new ServiceQuery(); }
export function ServiceModule(): ServiceModuleQuery { return new ServiceModuleQuery(); }
export function ServiceMember(): ServiceMemberQuery { return new ServiceMemberQuery(); }

export { CompilerError, ConnectCompiler, ConnectPlanCompiler, compileRequest } from './compiler.js';
export { planFromProto, requestToProto } from './compiler_bridge.js';
export type { CompilerTransport } from './compiler.js';
export * as CompilerProto from './gen/proto/orm/compiler/v1/compiler_pb.js';
