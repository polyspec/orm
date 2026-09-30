import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPhysicalCheck} from '../dist/physical_check.js';

test('physical CHECK exact fields and detached records',{timeout:3000},async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../contracts/fixtures/physical_checks.json',import.meta.url),'utf8'));
 assert.equal(fixture.cases.length,24);assert.equal(new Set(fixture.cases.map(c=>c.id)).size,24);
 for(const c of fixture.cases){
  assert(c.id.length>0);const value={...structuredClone(fixture.base),...structuredClone(c.changes)};
  if(c.error){assert.throws(()=>createPhysicalCheck(value),{message:c.error});continue;}
  const record=createPhysicalCheck(value);assert.deepEqual(record,value);
  assert(Object.isFrozen(record)&&Object.isFrozen(record.options)&&record.options.every(Object.isFrozen));
  if(value.options.length){value.options[0].value='changed';assert.notEqual(record.options[0].value,'changed');assert.throws(()=>{record.options[0].value='changed';},TypeError);}
 }
 assert.equal(fixture.bounds.length,17);assert.equal(new Set(fixture.bounds.map(c=>c.id)).size,17);
 for(const c of fixture.bounds){
  assert(c.id.length>0);const value=structuredClone(fixture.base);
  if(c.field)value[c.field]=c.unit.repeat(c.count);
  if(c.options)value.options=Array.from({length:c.options},()=>({name:'x',value:'x'.repeat(c.size)}));
  if(c.drop)delete value[c.drop];
  if(c.error)assert.throws(()=>createPhysicalCheck(value),{message:c.error});else assert.deepEqual(createPhysicalCheck(value),value);
 }
 assert.throws(()=>createPhysicalCheck({...fixture.base,expressionSql:'\ud800'}),{message:'SCHEMA_INVALID'});
 assert.throws(()=>createPhysicalCheck({...fixture.base,options:Array(1)}),{message:'SCHEMA_INVALID'});
});
