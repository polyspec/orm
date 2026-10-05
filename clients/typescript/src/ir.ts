// Value-free request and plan types (docs/protocol.md).

export type QueryKind = 'one' | 'all' | 'count' | 'group_count' | 'sum' | 'avg' | 'paginate' | 'insert' | 'update' | 'delete' | 'restore';

export interface RequestQuery {
  entity: string;
  columns?: Projection;
  on?: Group;
  where?: Group;
  joins?: Join[];
  relations?: Relation[];
  order?: Order[];
  group_by?: string[];
  group_by_expr?: GroupExpression[];
  limit?: Limit;
  force_index?: string;
  lock?: string;
  key_by?: string;
  flatten?: boolean;
  limit_per_parent?: number;
  if_parent?: IfParent;
  no_cascade_delete?: boolean;
}

export interface Request extends RequestQuery {
  ir_version: 1;
  manifest_hash: string;
  kind: QueryKind;
  set?: Assignment[];
  on_duplicate?: Assignment[];
  rows?: number[][];
  optimistic?: Optimistic;
  agg?: string;
  n_params: number;
}

export interface Group {
  conn?: string;
  /** A nested group negated as a whole: NOT (…). The top-level where and on groups are not negated. */
  not?: boolean;
  items: Item[];
}

export interface Item {
  pred?: Predicate;
  group?: Group;
  joined?: JoinedReference;
}

export interface JoinedReference { conn?: string; join: string; }
export interface Expression { sql: string; ps?: number[]; }
export interface OrmFunction { name: string; ps?: number[]; }
export interface ColumnFunction { column: string; fn: OrmFunction; }
export interface Subquery { query: RequestQuery; column?: string; agg?: string; }
export interface ColumnReferenceIR { path: string; column: string; }

export interface Predicate {
  conn?: string;
  column?: string;
  op?: string;
  p?: number;
  ps?: number[];
  ref?: ColumnReferenceIR;
  expr?: string;
  fn?: OrmFunction;
  value?: OrmFunction;
  cols?: string[];
  sub?: Subquery;
}

export interface Projection { mode?: '' | 'all' | 'none'; add?: string[]; remove?: string[]; expr?: Record<string, Expression>; fn?: Record<string, ColumnFunction>; sub?: Record<string, Subquery>; }
export interface Order { column?: string; expr?: string; desc?: boolean; random?: boolean; fn?: OrmFunction; }
export interface GroupExpression { expr: string; as: string; }
export interface Limit { offset: number; count: number; }
export interface IfParent { column: string; p: number; }
export interface Assignment { column: string; p?: number; null?: boolean; expr?: string; ps?: number[]; plus_p?: number; minus_p?: number; }
export interface Optimistic { column: string; p: number; }

export interface Relation {
  rel: string;
  query: RequestQuery;
  kind?: 'one' | 'many';
  keys?: KeyPair[];
}

/** 한 relation key 성분: 부모 column left와 자식 column right가 같다. composite key는 성분마다 한 쌍을 key 순서로 담는다. */
export interface KeyPair { left: string; right: string; }

export interface Join {
  rel: string;
  kind: 'inner' | 'left';
  query: RequestQuery;
  left?: string;
  right?: string;
}

export interface Plan {
  manifest_hash: string;
  kind: QueryKind;
  steps: PlanStep[];
}

export interface PlanStep { id: number; role: string; sql: string; tables: string[]; lock?: string; bind_slots: BindSlot[]; assemble?: Assemble; parent?: ParentReference; }
export interface BindSlot { from: string; param: number; transform: string; name: string; step: number; column: string; host_styles: string[]; col_type: string; key_types?: string[]; precision?: number; scale?: number; }
export interface PlanIfParent { column: string; index: number; param: number; }
export interface KeyReference { column: string; index: number; }
export interface ParentReference { step: number; keys: KeyReference[]; if_parent?: PlanIfParent; }
// aes_version은 AES column을 읽는 node에서 key version을 담은 columns 위치다.
export interface Assemble { entity: string; alias: string; columns: OutputColumn[]; children: Child[]; key: KeyReference[]; aes_version?: number; }
export interface OutputColumn { index: number; name: string; column: string; type: string; styles: string[]; hidden: boolean; }
export interface Child { rel: string; kind: string; step: number; parent_keys: KeyReference[]; child_keys: KeyReference[]; key: KeyReference[]; flatten: boolean; cascade: boolean; assemble?: Assemble; }
