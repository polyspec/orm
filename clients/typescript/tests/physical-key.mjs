import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPhysicalKey} from '../dist/physical_key.js';

test('shared immutable physical primary and unique key vectors',{timeout:3000},async(t)=>{
 const fixture=JSON.parse(await readFile(new URL('../../../contracts/fixtures/physical_keys.json',import.meta.url),'utf8'));
 assert.equal(fixture.cases.length,35);assert.equal(fixture.bounds.length,14);const cases=[...fixture.cases,...fixture.bounds];assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
 for(const c of cases){assert(c.id.length>0);await t.test(c.id,{timeout:1000},()=>{
  const value={...structuredClone(fixture.base),...structuredClone(c.changes??{})};
  if(c.drop)delete value[c.drop];if(c.field)value[c.field]=(c.unit??'x').repeat(c.count);
  if(c.columns)value.columns=Array.from({length:c.columns},(_,i)=>`column-${i}`);
  if(c.options)value.options=Array.from({length:c.options},()=>({name:'x',value:'x'.repeat(c.size)}));
  if(c.error){assert.throws(()=>createPhysicalKey(value),{message:c.error});return;}
  const key=createPhysicalKey(value);assert.deepEqual(key,value);assert(Object.isFrozen(key)&&Object.isFrozen(key.columns)&&Object.isFrozen(key.options)&&key.options.every(Object.isFrozen));
  value.columns[0]='changed';assert.notEqual(key.columns[0],'changed');assert.throws(()=>{key.columns[0]='changed';},TypeError);
  if(value.options.length){value.options[0].value='changed';assert.notEqual(key.options[0].value,'changed');assert.throws(()=>{key.options[0].value='changed';},TypeError);}
 });}
 for(const field of ['name','indexId','comment'])assert.throws(()=>createPhysicalKey({...fixture.base,[field]:'\ud800'}),{message:'SCHEMA_INVALID'});
 for(const field of ['columns','options'])assert.throws(()=>createPhysicalKey({...fixture.base,[field]:Array(1)}),{message:'SCHEMA_INVALID'});
});
