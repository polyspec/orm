import {createPhysicalIdentity} from './physical.js';
import {PhysicalRecord, invalid, shape} from './physical_record.js';

/** Structural constraint interchange; never SQL execution permission. */
export interface PhysicalCheck {
 readonly id:string;
 readonly name:string|null;
 readonly tableId:string;
 readonly expressionSql:string;
 readonly enforced:boolean|null;
 readonly validated:boolean|null;
 readonly comment:string;
 readonly options:readonly Readonly<{name:string;value:string}>[];
}

export function createPhysicalCheck(value:unknown):PhysicalCheck {
 const record=shape(value,['id','name','tableId','expressionSql','enforced','validated','comment','options']);
 const validator=new PhysicalRecord();
 const id=validator.id(record.id),tableId=validator.id(record.tableId);
 let name:string|null=null;
 if(record.name!==null){name=validator.text(record.name,1,1024);createPhysicalIdentity([null,null,name,null]);}
 const expressionSql=validator.text(record.expressionSql,1,16384);
 const state=(value:unknown):boolean|null=>{if(value!==null&&typeof value!=='boolean')invalid();return value;};
 const enforced=state(record.enforced),validated=state(record.validated);
 const comment=validator.text(record.comment,0,8192),options=validator.options(record.options);
 return Object.freeze({id,name,tableId,expressionSql,enforced,validated,comment,options});
}
