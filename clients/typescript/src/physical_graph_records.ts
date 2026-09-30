import {createPhysicalIndex,type PhysicalIndex} from './physical_index.js';
import {createPhysicalKey,type PhysicalKey} from './physical_key.js';
import {createPhysicalCheck} from './physical_check.js';

interface Context {
 reserve:(id:string,path:string)=>void;
 tableIds:Set<string>;
 owners:Map<string,string>;
 constraintNames:Map<string,Set<string>>;
 budget:(record:unknown,path:string)=>void;
 at:<T>(path:string,run:()=>T)=>T;
 fail:(path:string)=>never;
}

/** Input list bounds and table/column membership are already validated. */
export function resolveGraphRecords(input:{indices:unknown[];keys:unknown[];checks:unknown[]},ctx:Context){
 const {reserve,tableIds,owners,constraintNames,budget,at,fail}=ctx;
 const register=(record:{id:string;tableId:string;name:string|null},path:string,namespace:Map<string,Set<string>>)=>{
  reserve(record.id,`${path}/id`);if(!tableIds.has(record.tableId))fail(`${path}/tableId`);
  if(record.name!==null){let names=namespace.get(record.tableId);if(!names){names=new Set();namespace.set(record.tableId,names);}if(names.has(record.name))fail(`${path}/name`);names.add(record.name);}
 };
 const indexNames=new Map<string,Set<string>>(),byId=new Map<string,PhysicalIndex>();
 const indices=Object.freeze(Array.from(input.indices,(input,i)=>{
  const path=`/indices/${i}`,index=at(path,()=>createPhysicalIndex(input));register(index,path,indexNames);
  for(const[j,term]of index.terms.entries())if(term.source.kind==='column'&&owners.get(term.source.columnId)!==index.tableId)fail(`${path}/terms/${j}/source/columnId`);
  for(const[j,column]of index.include.entries())if(owners.get(column)!==index.tableId)fail(`${path}/include/${j}`);
  budget(index,path);byId.set(index.id,index);return index;
 }));
 const primary=new Set<string>(),linked=new Set<string>();
 const keys=Object.freeze(Array.from(input.keys,(input,i)=>{
  const path=`/keys/${i}`,key=at(path,()=>createPhysicalKey(input));register(key,path,constraintNames);
  for(const[j,column]of key.columns.entries())if(owners.get(column)!==key.tableId)fail(`${path}/columns/${j}`);
  if(key.kind==='primary'){if(primary.has(key.tableId))fail(`${path}/kind`);primary.add(key.tableId);}
  if(key.indexId!==null){const index=byId.get(key.indexId);if(!index||linked.has(key.indexId)||!matches(index,key))fail(`${path}/indexId`);linked.add(key.indexId);}
  budget(key,path);return key;
 }));
 const checks=Object.freeze(Array.from(input.checks,(input,i)=>{
  const path=`/checks/${i}`,check=at(path,()=>createPhysicalCheck(input));register(check,path,constraintNames);budget(check,path);return check;
 }));
 return {indices,keys,checks};
}

function matches(index:PhysicalIndex,key:PhysicalKey):boolean{
 if(index.tableId!==key.tableId||index.predicateSql!==null||(key.withoutOverlaps!==true&&!index.unique)||index.terms.length!==key.columns.length)return false;
 if(index.terms.some((term,i)=>term.source.kind!=='column'||term.source.columnId!==key.columns[i]))return false;
 return key.nullsDistinct===null||index.nullsDistinct===null||key.nullsDistinct===index.nullsDistinct;
}
