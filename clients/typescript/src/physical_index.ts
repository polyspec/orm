import {createPhysicalIdentity} from './physical.js';
import {PhysicalRecord, invalid, shape} from './physical_record.js';

export type PhysicalIndexSource=Readonly<{kind:'column';columnId:string}>|Readonly<{kind:'expression';sql:string}>;
export interface PhysicalIndexTerm {
 readonly source:PhysicalIndexSource;
 readonly order:'asc'|'desc'|'unspecified';
 readonly nulls:'first'|'last'|'unspecified';
 readonly collationSql:string|null;
 readonly operatorClassSql:string|null;
 readonly prefixLength:number|null;
}
/** Structural index interchange; never SQL execution permission. */
export interface PhysicalIndex {
 readonly id:string;
 readonly name:string|null;
 readonly tableId:string;
 readonly unique:boolean;
 readonly methodSql:string|null;
 readonly terms:readonly PhysicalIndexTerm[];
 readonly include:readonly string[];
 readonly predicateSql:string|null;
 readonly nullsDistinct:boolean|null;
 readonly visible:boolean|null;
 readonly comment:string;
 readonly options:readonly Readonly<{name:string;value:string}>[];
}

function optionalText(v:PhysicalRecord,value:unknown,max:number):string|null {
 return value===null?null:v.text(value,1,max);
}

function term(v:PhysicalRecord,value:unknown):PhysicalIndexTerm {
 const input=shape(value,['source','order','nulls','collationSql','operatorClassSql','prefixLength']);
 if(input.source===null||typeof input.source!=='object'||Array.isArray(input.source))invalid();
 const kind=v.text((input.source as Record<string,unknown>).kind,1,16);
 let source:PhysicalIndexSource;
 if(kind==='column'){const inputSource=shape(input.source,['kind','columnId']);source=Object.freeze({kind,columnId:v.id(inputSource.columnId)});}
 else if(kind==='expression'){const inputSource=shape(input.source,['kind','sql']);source=Object.freeze({kind,sql:v.text(inputSource.sql,1,16384)});}
 else invalid();
 const order=v.text(input.order,1,16),nulls=v.text(input.nulls,1,16);
 if(!['asc','desc','unspecified'].includes(order)||!['first','last','unspecified'].includes(nulls))invalid();
 const collationSql=optionalText(v,input.collationSql,1024),operatorClassSql=optionalText(v,input.operatorClassSql,4096);
 const prefixLength=input.prefixLength;
 if(prefixLength!==null&&(kind!=='column'||typeof prefixLength!=='number'||!Number.isInteger(prefixLength)||prefixLength<1||prefixLength>2147483647))invalid();
 return Object.freeze({source,order:order as PhysicalIndexTerm['order'],nulls:nulls as PhysicalIndexTerm['nulls'],collationSql,operatorClassSql,prefixLength:prefixLength as number|null});
}

export function createPhysicalIndex(value:unknown):PhysicalIndex {
 const record=shape(value,['id','name','tableId','unique','methodSql','terms','include','predicateSql','nullsDistinct','visible','comment','options']);
 const v=new PhysicalRecord(),id=v.id(record.id),tableId=v.id(record.tableId);
 const name=optionalText(v,record.name,1024);if(name!==null)createPhysicalIdentity([null,null,name,null]);
 const unique=record.unique;if(typeof unique!=='boolean')invalid();
 const state=(value:unknown):boolean|null=>{if(value!==null&&typeof value!=='boolean')invalid();return value;};
 const nullsDistinct=state(record.nullsDistinct),visible=state(record.visible);
 const methodSql=optionalText(v,record.methodSql,128),predicateSql=optionalText(v,record.predicateSql,16384);
 if(!Array.isArray(record.terms)||record.terms.length<1||record.terms.length>64)invalid();
 const terms=Object.freeze(Array.from(record.terms,value=>term(v,value)));
 if(!Array.isArray(record.include)||record.include.length>64)invalid();
 const seen=new Set<string>();const include=Object.freeze(Array.from(record.include,value=>{const id=v.id(value);if(seen.has(id))invalid();seen.add(id);return id;}));
 const comment=v.text(record.comment,0,8192),options=v.options(record.options);
 return Object.freeze({id,name,tableId,unique,methodSql,terms,include,predicateSql,nullsDistinct,visible,comment,options});
}
