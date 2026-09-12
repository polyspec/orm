import { create } from '@bufbuild/protobuf';
import {
  CompileRequestSchema, QueryKind as WireKind, type CompileRequest as WireRequest,
  type Plan as WirePlan,
} from './gen/proto/orm/compiler/v1/compiler_pb.js';
import type { Assemble, Group, Plan, QueryKind, Request, RequestQuery } from './index.js';
import { CompilerError } from './compiler_error.js';

const kinds: Record<QueryKind, WireKind> = {
  one: WireKind.ONE, all: WireKind.ALL, count: WireKind.COUNT, group_count: WireKind.GROUP_COUNT,
  count_distinct: WireKind.COUNT_DISTINCT, sum: WireKind.SUM, avg: WireKind.AVG,
  min: WireKind.MIN, max: WireKind.MAX, paginate: WireKind.PAGINATE, insert: WireKind.INSERT,
  update: WireKind.UPDATE, delete: WireKind.DELETE, raw: WireKind.RAW,
};
const kindNames = new Map(Object.entries(kinds).map(([name, value]) => [value, name as QueryKind]));

function uint(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new CompilerError('IR_INVALID', `${path} is outside uint32`);
  return value;
}

function group(value: Group | undefined, path: string): any {
  if (!value) return undefined;
  return {
    connector: value.conn ?? '',
    items: value.items.map((item, index) => {
      const itemPath = `${path}.items[${index}]`;
      const count = Number(item.pred !== undefined) + Number(item.group !== undefined) + Number(item.nav !== undefined);
      if (count !== 1) throw new CompilerError('IR_INVALID', `${itemPath} must contain exactly one value`);
      if (item.pred) return { value: { case: 'predicate', value: { connector:item.pred.conn??'', column:item.pred.column??'', operator:item.pred.op??'', parameter:item.pred.p === undefined ? undefined : uint(item.pred.p,`${itemPath}.predicate.parameter`), parameters:(item.pred.ps??[]).map((p,i)=>uint(p,`${itemPath}.predicate.parameters[${i}]`)), reference:item.pred.ref, expression:item.pred.expr??'', matchColumns:item.pred.match??[] } } };
      if (item.group) return { value: { case: 'group', value: group(item.group, `${itemPath}.group`) } };
      return { value: { case: 'navigation', value: { connector:item.nav!.conn??'', relation:item.nav!.rel, group:group(item.nav!.group,`${itemPath}.navigation.group`) } } };
    }),
  };
}

function query(value: RequestQuery, path: string): any {
  const modes = { '': 0, all: 1, none: 2 } as const;
  const mode = value.columns?.mode ?? '';
  if (!(mode in modes)) throw new CompilerError('IR_INVALID', `${path}.columns.mode is invalid`);
  return {
    entity:value.entity,
    columns:value.columns ? { mode:modes[mode], add:value.columns.add??[], remove:value.columns.remove??[], aliases:value.columns.as??{}, expressions:value.columns.expr??{} } : undefined,
    on:group(value.on,`${path}.on`), where:group(value.where,`${path}.where`), having:group(value.having,`${path}.having`),
    joins:(value.joins??[]).map((v,i)=>({relation:v.rel,kind:v.kind,query:query(v.query,`${path}.joins[${i}].query`)})),
    relations:(value.relations??[]).map((v,i)=>({relation:v.rel,query:query(v.query,`${path}.relations[${i}].query`)})),
    order:(value.order??[]).map(v=>({column:v.column??'',expression:v.expr??'',descending:v.desc??false})),
    groupBy:value.group_by??[], groupByExpression:(value.group_by_expr??[]).map(v=>({expression:v.expr,alias:v.as})),
    limit:value.limit ? {offset:uint(value.limit.offset,`${path}.limit.offset`),count:uint(value.limit.count,`${path}.limit.count`)} : undefined,
    distinct:value.distinct??false, forceIndex:value.force_index??'', keyBy:value.key_by??'', flatten:value.flatten??false,
    limitPerParent:uint(value.limit_per_parent??0,`${path}.limit_per_parent`),
    ifParent:value.if_parent ? {column:value.if_parent.column,parameter:uint(value.if_parent.p,`${path}.if_parent.parameter`)} : undefined,
    dropChildKey:value.drop_child_key??false, noCascadeDelete:value.no_cascade_delete??false,
    scopeParameter:value.scope_p === undefined ? undefined : uint(value.scope_p,`${path}.scope_parameter`),
  };
}

export function requestToProto(value: Request): WireRequest {
  const assignments = (values: Request['set'], path:string) => (values??[]).map((v,i)=>({column:v.column,parameter:v.p===undefined?undefined:uint(v.p,`${path}[${i}].parameter`),setNull:v.null??false,expression:v.expr??'',expressionParameters:(v.ps??[]).map((p,j)=>uint(p,`${path}[${i}].expression_parameters[${j}]`)),plusParameter:v.plus_p===undefined?undefined:uint(v.plus_p,`${path}[${i}].plus_parameter`),minusParameter:v.minus_p===undefined?undefined:uint(v.minus_p,`${path}[${i}].minus_parameter`)}));
  return create(CompileRequestSchema, {
    irVersion:value.ir_version, schemaHash:value.schema_hash, kind:kinds[value.kind], root:query(value,'root'),
    set:assignments(value.set,'set'), onDuplicate:assignments(value.on_duplicate,'on_duplicate'),
    optimistic:value.optimistic ? {column:value.optimistic.column,parameter:uint(value.optimistic.p,'optimistic.parameter')} : undefined,
    raw:value.raw ? {sql:value.raw.sql,parameters:(value.raw.ps??[]).map((p,i)=>uint(p,`raw.parameters[${i}]`))} : undefined,
    parameterCount:uint(value.n_params,'parameter_count'), aggregate:value.agg??'', debug:value.debug??false,
  });
}

function assemble(value: NonNullable<WirePlan['steps'][number]['assemble']>): Assemble {
  return {entity:value.entity,alias:value.alias,columns:value.columns.map(v=>({index:v.index,name:v.name,column:v.column,type:v.type,styles:[...v.styles],hidden:v.hidden})),children:value.children.map(v=>({rel:v.relation,kind:v.kind,step:v.step,parent_keys:v.parentKeys.map(k=>({column:k.column,index:k.index})),child_keys:v.childKeys.map(k=>({column:k.column,index:k.index})),key:v.key.map(k=>({column:k.column,index:k.index})),flatten:v.flatten,cascade:v.cascade,assemble:v.assemble?assemble(v.assemble):undefined}))};
}

export function planFromProto(value: WirePlan): Plan {
  const kind = kindNames.get(value.kind);
  if (!kind) throw new CompilerError('INTERNAL', `compiler returned unknown query kind ${value.kind}`);
  return {schema_hash:value.schemaHash,kind,steps:value.steps.map(v=>({id:v.id,role:v.role,sql:v.sql,bind_slots:v.binds.map(b=>({from:b.source,param:b.parameter,transform:b.transform,name:b.name,step:b.step,column:b.column,host_styles:[...b.hostStyles],col_type:b.columnType})),assemble:v.assemble?assemble(v.assemble):undefined,parent:v.parent?{step:v.parent.step,keys:v.parent.keys.map(k=>({column:k.column,index:k.index})),if_parent:v.parent.ifParent?{column:v.parent.ifParent.column,index:v.parent.ifParent.index,param:v.parent.ifParent.parameter}:undefined}:undefined}))};
}
