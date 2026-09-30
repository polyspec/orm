import {createPhysicalIdentity} from './physical.js';
import {PhysicalRecord, invalid, shape} from './physical_record.js';

/** Structural key interchange; never dialect execution permission. */
export interface PhysicalKey {
 readonly id:string;
 readonly name:string|null;
 readonly tableId:string;
 readonly kind:'primary'|'unique';
 readonly columns:readonly string[];
 readonly indexId:string|null;
 readonly deferrable:boolean|null;
 readonly initiallyDeferred:boolean|null;
 readonly nullsDistinct:boolean|null;
 readonly withoutOverlaps:boolean|null;
 readonly comment:string;
 readonly options:readonly Readonly<{name:string;value:string}>[];
}

export function createPhysicalKey(value:unknown):PhysicalKey {
 const record=shape(value,['id','name','tableId','kind','columns','indexId','deferrable','initiallyDeferred','nullsDistinct','withoutOverlaps','comment','options']);
 const v=new PhysicalRecord(),id=v.id(record.id),tableId=v.id(record.tableId);
 const name=record.name===null?null:v.text(record.name,1,1024);if(name!==null)createPhysicalIdentity([null,null,name,null]);
 const kind=v.text(record.kind,1,16);if(kind!=='primary'&&kind!=='unique')invalid();
 const columns=v.ids(record.columns),indexId=record.indexId===null?null:v.id(record.indexId);
 const state=(value:unknown):boolean|null=>{if(value!==null&&typeof value!=='boolean')invalid();return value;};
 const deferrable=state(record.deferrable),initiallyDeferred=state(record.initiallyDeferred),nullsDistinct=state(record.nullsDistinct),withoutOverlaps=state(record.withoutOverlaps);
 if(initiallyDeferred===true&&deferrable!==true)invalid();if(kind==='primary'&&nullsDistinct!==null)invalid();
 const comment=v.text(record.comment,0,8192),options=v.options(record.options);
 return Object.freeze({id,name,tableId,kind,columns,indexId,deferrable,initiallyDeferred,nullsDistinct,withoutOverlaps,comment,options});
}
