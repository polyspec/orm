export type Param = unknown;
type Terminal = 'get' | 'gets' | 'count';

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

export interface Request {
  ir_version: 1;
  schema_hash: string;
  kind: 'all' | 'count';
  entity: string;
  where?: Group;
  relations?: Relation[];
  n_params: number;
}

export interface Group {
  items: Item[];
}

export interface Item {
  pred?: Predicate;
  group?: Group;
}

export interface Predicate {
  conn?: 'or';
  column: string;
  op: 'eq';
  p: number;
}

export interface Relation {
  rel: string;
  query: { entity: string; where?: Group };
}

export interface Plan {
  schema_hash: string;
  steps: unknown[];
}

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
  public scope(value: number): this { return this.eq('service_seq', value); }
  public isCloseEq(value: boolean): this { return this.eq('is_close', value); }
  public isDisplayEq(value: boolean): this { return this.eq('is_display', value); }
  public isAlldayEq(value: boolean): this { return this.eq('is_allday', value); }

  private pendingOr = false;

  private eq(column: string, value: Param): this {
    const p = this.params.push(value) - 1;
    const item: Item = { pred: { column, op: 'eq', p } };
    if (this.pendingOr) item.pred!.conn = 'or';
    this.pendingOr = false;
    this.group.items.push(item);
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
    return this.condition('service_seq', value);
  }
  public isCloseEq(value: boolean): this { return this.condition('is_close', value); }
  public isDisplayEq(value: boolean): this { return this.condition('is_display', value); }
  public isAlldayEq(value: boolean): this { return this.condition('is_allday', value); }

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
    this.request.relations = [...(this.request.relations ?? []), { rel, query }];
    return this;
  }

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
