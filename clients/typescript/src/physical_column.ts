/** Structural interchange only; SQL semantics remain dialect-owned. */
export type PhysicalDefault=Readonly<{kind:'absent'|'null'}|{kind:'literal'|'expression';sql:string}>;
export type PhysicalGeneration=Readonly<{kind:'none'}|{kind:'identity';sql:string}|{kind:'computed';sql:string;storage:'stored'|'virtual'|'unspecified'}>;
export interface PhysicalColumn {
  readonly id:string;readonly name:string;readonly typeSql:string;readonly nullable:boolean;
  readonly default:PhysicalDefault;readonly generation:PhysicalGeneration;readonly comment:string;
  readonly options:readonly Readonly<{name:string;value:string}>[];
}
import {createPhysicalIdentity} from './physical.js';
function invalid():never {throw new Error('SCHEMA_INVALID');}
function shape(value:unknown,fields:readonly string[]):Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value))invalid();
  const record=value as Record<string,unknown>;
  if(Object.keys(record).length!==fields.length||fields.some(field=>!Object.hasOwn(record,field)))invalid();
  return record;
}
export function createPhysicalColumn(value:unknown):PhysicalColumn {
  const record=shape(value,['id','name','typeSql','nullable','default','generation','comment','options']);
  let bytes=0;const encoder=new TextEncoder();
  const text=(value:unknown,min:number,max:number):string=>{
    if(typeof value!=='string'||value.length>max||value.includes('\0'))invalid();
    for(const char of value){const point=char.codePointAt(0)!;if(point>=0xd800&&point<=0xdfff)invalid();}
    const size=encoder.encode(value).length;
    if(size<min||size>max||(bytes+=size)>65536)invalid();
    return value;
  };
  const id=text(record.id,1,128);if(!/^[A-Za-z0-9_-]+$/.test(id))invalid();
  const name=text(record.name,1,1024);createPhysicalIdentity([null,null,name,null]);
  const typeSql=text(record.typeSql,1,4096),comment=text(record.comment,0,8192);
  if(typeof record.nullable!=='boolean')invalid();
  const defaultInput=record.default as Record<string,unknown>|null;
  const defaultKind=text(defaultInput?.kind,1,16);
  let defaultValue:PhysicalDefault;
  if(defaultKind==='absent'||defaultKind==='null'){
    shape(defaultInput,['kind']);defaultValue=Object.freeze({kind:defaultKind});
  }else if(defaultKind==='literal'||defaultKind==='expression'){
    const input=shape(defaultInput,['kind','sql']);defaultValue=Object.freeze({kind:defaultKind,sql:text(input.sql,1,16384)});
  }else return invalid();
  const generationInput=record.generation as Record<string,unknown>|null;
  const generationKind=text(generationInput?.kind,1,16);
  let generation:PhysicalGeneration;
  if(generationKind==='none'){shape(generationInput,['kind']);generation=Object.freeze({kind:'none'});}
  else if(generationKind==='identity'){
    const input=shape(generationInput,['kind','sql']);generation=Object.freeze({kind:'identity',sql:text(input.sql,1,16384)});
  }else if(generationKind==='computed'){
    const input=shape(generationInput,['kind','sql','storage']);
    const sql=text(input.sql,1,16384),storage=text(input.storage,1,16);
    if(storage!=='stored'&&storage!=='virtual'&&storage!=='unspecified')invalid();
    generation=Object.freeze({kind:'computed',sql,storage});
  }else return invalid();
  if(!Array.isArray(record.options)||record.options.length>64)invalid();
  const options=Object.freeze(Array.from(record.options,option=>{
    const entry=shape(option,['name','value']);return Object.freeze({name:text(entry.name,1,128),value:text(entry.value,0,4096)});
  }));
  return Object.freeze({id,name,typeSql,nullable:record.nullable,default:defaultValue,generation,comment,options});
}
