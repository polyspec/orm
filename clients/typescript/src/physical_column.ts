/** Structural interchange only; SQL semantics remain dialect-owned. */
export type PhysicalDefault=Readonly<{kind:'absent'|'null'}|{kind:'literal'|'expression';sql:string}>;
export type PhysicalGeneration=Readonly<{kind:'none'}|{kind:'identity';sql:string}|{kind:'computed';sql:string;storage:'stored'|'virtual'|'unspecified'}>;
export interface PhysicalColumn {
  readonly id:string;readonly name:string;readonly typeSql:string;readonly nullable:boolean;
  readonly default:PhysicalDefault;readonly generation:PhysicalGeneration;readonly comment:string;
  readonly options:readonly Readonly<{name:string;value:string}>[];
}
import {createPhysicalIdentity} from './physical.js';
import {PhysicalRecord,invalid,shape} from './physical_record.js';
export function createPhysicalColumn(value:unknown):PhysicalColumn {
  const record=shape(value,['id','name','typeSql','nullable','default','generation','comment','options']);
  const validator=new PhysicalRecord();const text=validator.text.bind(validator);
  const id=validator.id(record.id);
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
  const options=validator.options(record.options);
  return Object.freeze({id,name,typeSql,nullable:record.nullable,default:defaultValue,generation,comment,options});
}
