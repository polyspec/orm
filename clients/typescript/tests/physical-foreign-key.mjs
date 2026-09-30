import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile}from'node:fs/promises';
import {createPhysicalForeignKey}from'../dist/physical_foreign_key.js';
test('shared physical FK vectors preserve order actions and immutability',{timeout:3000},async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../contracts/fixtures/physical_foreign_keys.json',import.meta.url),'utf8'));
 assert.equal(fixture.cases.length,26);assert.equal(new Set(fixture.cases.map(c=>c.id)).size,26);
 for(const c of fixture.cases){
  assert(c.id.length>0);const value={...structuredClone(fixture.base),...structuredClone(c.changes)};
  if(c.error){assert.throws(()=>createPhysicalForeignKey(value),{message:c.error});continue;}
  const fk=createPhysicalForeignKey(value);assert.deepEqual(fk,value);
  value.columns[0]='changed';value.target.tableId='changed';
  assert.notEqual(fk.columns[0],'changed');assert.notEqual(fk.target.tableId,'changed');
  assert(Object.isFrozen(fk)&&Object.isFrozen(fk.columns)&&Object.isFrozen(fk.target)&&Object.isFrozen(fk.target.columns)&&Object.isFrozen(fk.options));
 }
 assert.throws(()=>createPhysicalForeignKey({...fixture.base,columns:Array(2)}),{message:'SCHEMA_INVALID'});
 const ids=Array.from({length:64},(_,index)=>`column-${index}`);
 assert.doesNotThrow(()=>createPhysicalForeignKey({...fixture.base,columns:ids,target:{tableId:'parent',columns:ids}}));
 const oversized=[...ids,'column-64'];
 assert.throws(()=>createPhysicalForeignKey({...fixture.base,columns:oversized,target:{tableId:'parent',columns:oversized}}),{message:'SCHEMA_INVALID'});
 const started=performance.now();const retained=Array.from({length:2000},(_,index)=>createPhysicalForeignKey({...fixture.base,id:`fk-${index}`,name:`FK.${index}`}));
 for(const[index,fk]of retained.entries())assert.equal(fk.id,`fk-${index}`);
 console.log(JSON.stringify({event:'physical-fk-retention',records:retained.length,elapsedMs:performance.now()-started}));
});
