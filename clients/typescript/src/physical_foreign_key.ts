/** Exact physical FK interchange, not graph resolution or execution permission. */
import {createPhysicalIdentity}from'./physical.js';
import {PhysicalRecord,invalid,shape}from'./physical_record.js';
export type PhysicalAction='noAction'|'restrict'|'cascade'|'setNull'|'setDefault'|'unspecified';
export type PhysicalMatch='simple'|'full'|'partial'|'unspecified';
export interface PhysicalForeignKey{
 readonly id:string;readonly name:string|null;readonly tableId:string;readonly columns:readonly string[];
 readonly target:Readonly<{tableId:string;columns:readonly string[]}>;
 readonly onDelete:PhysicalAction;readonly onUpdate:PhysicalAction;readonly match:PhysicalMatch;
 readonly deferrable:boolean|null;readonly initiallyDeferred:boolean|null;readonly comment:string;
 readonly options:readonly Readonly<{name:string;value:string}>[];
}
export function createPhysicalForeignKey(value:unknown):PhysicalForeignKey{
 const record=shape(value,['id','name','tableId','columns','target','onDelete','onUpdate','match','deferrable','initiallyDeferred','comment','options']);
 const v=new PhysicalRecord();const id=v.id(record.id),tableId=v.id(record.tableId);
 const name=record.name===null?null:v.text(record.name,1,1024);if(name!==null)createPhysicalIdentity([null,null,name,null]);
 const columns=v.ids(record.columns),input=shape(record.target,['tableId','columns']);
 const target=Object.freeze({tableId:v.id(input.tableId),columns:v.ids(input.columns)});if(columns.length!==target.columns.length)invalid();
 const action=(value:unknown):PhysicalAction=>{
  const action=v.text(value,1,16);if(!['noAction','restrict','cascade','setNull','setDefault','unspecified'].includes(action))invalid();return action as PhysicalAction;
 };
 const onDelete=action(record.onDelete),onUpdate=action(record.onUpdate);
 const match=v.text(record.match,1,16);if(!['simple','full','partial','unspecified'].includes(match))invalid();
 const nullableBoolean=(value:unknown):boolean|null=>{if(value!==null&&typeof value!=='boolean')invalid();return value;};
 const deferrable=nullableBoolean(record.deferrable),initiallyDeferred=nullableBoolean(record.initiallyDeferred);
 if(initiallyDeferred===true&&deferrable!==true)invalid();
 const comment=v.text(record.comment,0,8192),options=v.options(record.options);
 return Object.freeze({id,name,tableId,columns,target,onDelete,onUpdate,match:match as PhysicalMatch,deferrable,initiallyDeferred,comment,options});
}
