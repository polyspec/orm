/** Bounded physical nodes and FK membership; not complete schema or SQL validation. */
import {createPhysicalIdentity, type PhysicalParts} from './physical.js';
import {createPhysicalColumn, type PhysicalColumn} from './physical_column.js';
import {createPhysicalForeignKey, type PhysicalForeignKey} from './physical_foreign_key.js';
import {PhysicalRecord, shape} from './physical_record.js';

export class PhysicalGraphError extends Error {
 readonly code='SCHEMA_INVALID';
 constructor(readonly path:string){super('SCHEMA_INVALID');this.name='PhysicalGraphError';Object.freeze(this);}
}
export interface PhysicalTable {
 readonly id:string; readonly identity:PhysicalParts; readonly columns:readonly PhysicalColumn[];
 readonly comment:string; readonly options:readonly Readonly<{name:string;value:string}>[];
}
export interface PhysicalGraph {
 readonly version:1; readonly dialect:'mysql'|'postgres'|'sqlite'; readonly dialectVersion:string;
 readonly tables:readonly PhysicalTable[]; readonly foreignKeys:readonly PhysicalForeignKey[];
}
function fail(path:string):never{throw new PhysicalGraphError(path);}
function at<T>(path:string,run:()=>T):T{
 try{return run();}catch(error){if(error instanceof PhysicalGraphError)throw error;if(error instanceof Error&&error.message==='SCHEMA_INVALID')fail(path);throw error;}
}
function list(value:unknown,max:number,path:string,min=0):unknown[]{
 if(!Array.isArray(value)||value.length<min||value.length>max)fail(path);return value;
}
/** Call only on validated, newly owned, bounded-depth records. */
function stringBytes(value:unknown,encoder:TextEncoder):number{
 if(typeof value==='string')return encoder.encode(value).length;
 if(value===null||typeof value!=='object')return 0;
 let total=0;for(const child of Object.values(value))total+=stringBytes(child,encoder);return total;
}
export function createPhysicalGraph(value:unknown):PhysicalGraph{
 const root=at('',()=>shape(value,['version','dialect','dialectVersion','tables','foreignKeys']));
 if(root.version!==1)fail('/version');
 if(root.dialect!=='mysql'&&root.dialect!=='postgres'&&root.dialect!=='sqlite')fail('/dialect');
 const dialect=root.dialect,dialectVersion=at('/dialectVersion',()=>new PhysicalRecord().text(root.dialectVersion,1,128));
 const inputTables=list(root.tables,4096,'/tables'),inputFKs=list(root.foreignKeys,20000,'/foreignKeys');
 const ids=new Set<string>(),identities=new Set<string>(),tableIds=new Set<string>(),owners=new Map<string,string>();
 const encoder=new TextEncoder();let bytes=encoder.encode(dialect+dialectVersion).length,columnCount=0;
 const reserve=(id:string,path:string)=>{if(ids.has(id))fail(path);ids.add(id);};
 const budget=(record:unknown,path:string)=>{bytes+=stringBytes(record,encoder);if(bytes>16*1024*1024)fail(path);};
 const tables=Array.from(inputTables,(input,index):PhysicalTable=>{
  const path=`/tables/${index}`,record=at(path,()=>shape(input,['id','identity','columns','comment','options']));
  const validator=new PhysicalRecord(),id=at(`${path}/id`,()=>validator.id(record.id));reserve(id,`${path}/id`);
  const identity=at(`${path}/identity`,()=>createPhysicalIdentity(record.identity as PhysicalParts));
  if(identity.parts[3]!==null||identities.has(identity.key))fail(`${path}/identity`);identities.add(identity.key);tableIds.add(id);
  const inputs=list(record.columns,4096,`${path}/columns`,1);columnCount+=inputs.length;if(columnCount>120000)fail(`${path}/columns`);
  const names=new Set<string>();
  const columns=Object.freeze(Array.from(inputs,(input,index)=>{
   const columnPath=`${path}/columns/${index}`,column=at(columnPath,()=>createPhysicalColumn(input));
   reserve(column.id,`${columnPath}/id`);if(names.has(column.name))fail(`${columnPath}/name`);names.add(column.name);owners.set(column.id,id);budget(column,columnPath);return column;
  }));
  const comment=at(`${path}/comment`,()=>validator.text(record.comment,0,8192));
  const options=at(`${path}/options`,()=>validator.options(record.options));
  const metadata={id,identity:identity.parts,comment,options};
  if(stringBytes(metadata,encoder)>65536)fail(path);budget(metadata,path);
  return Object.freeze({id,identity:identity.parts,columns,comment,options});
 });
 const constraintNames=new Map<string,Set<string>>();
 const foreignKeys=Array.from(inputFKs,(input,index)=>{
  const path=`/foreignKeys/${index}`,fk=at(path,()=>createPhysicalForeignKey(input));reserve(fk.id,`${path}/id`);
  if(!tableIds.has(fk.tableId))fail(`${path}/tableId`);if(!tableIds.has(fk.target.tableId))fail(`${path}/target/tableId`);
  for(let i=0;i<fk.columns.length;i++){
   if(owners.get(fk.columns[i])!==fk.tableId)fail(`${path}/columns/${i}`);
   if(owners.get(fk.target.columns[i])!==fk.target.tableId)fail(`${path}/target/columns/${i}`);
  }
  if(fk.name!==null){let names=constraintNames.get(fk.tableId);if(!names){names=new Set();constraintNames.set(fk.tableId,names);}if(names.has(fk.name))fail(`${path}/name`);names.add(fk.name);}
  budget(fk,path);return fk;
 });
 return Object.freeze({version:1,dialect,dialectVersion,tables:Object.freeze(tables),foreignKeys:Object.freeze(foreignKeys)});
}
