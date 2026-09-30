import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPhysicalIndex} from '../dist/physical_index.js';

test('shared immutable physical index vectors',{timeout:3000},async(t)=>{
 const fixture=JSON.parse(await readFile(new URL('../../../contracts/fixtures/physical_indices.json',import.meta.url),'utf8'));
 assert.equal(fixture.cases.length,46);assert.equal(fixture.bounds.length,20);
 const cases=[...fixture.cases,...fixture.bounds];assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
 for(const c of cases){
  assert(c.id.length>0);await t.test(c.id,{timeout:1000},()=>{
   const value={...structuredClone(fixture.base),...structuredClone(c.changes??{})};
   if(c.termChanges)Object.assign(value.terms[0],structuredClone(c.termChanges));
   if(c.drop)delete value[c.drop];
   if(c.field)value[c.field]=(c.unit??'x').repeat(c.count);
   if(c.termField)value.terms[0][c.termField]=(c.unit??'x').repeat(c.count);
   if(c.expression)value.terms[0].source={kind:'expression',sql:'x'.repeat(c.expression)};
   if(c.terms)value.terms=Array.from({length:c.terms},()=>structuredClone(value.terms[0]));
   if(c.include)value.include=Array.from({length:c.include},(_,i)=>`included-${i}`);
   if(c.options)value.options=Array.from({length:c.options},()=>({name:'x',value:'x'.repeat(c.size)}));
   if(c.error){assert.throws(()=>createPhysicalIndex(value),{message:c.error});return;}
   const index=createPhysicalIndex(value);assert.deepEqual(index,value);
   const frozen=value=>{if(value!==null&&typeof value==='object'){assert(Object.isFrozen(value));for(const child of Object.values(value))frozen(child);}};frozen(index);
   value.terms[0].source.kind='changed';assert.notEqual(index.terms[0].source.kind,'changed');
   assert.throws(()=>{index.terms[0].source.kind='changed';},TypeError);
  });
 }
 for(const field of ['name','methodSql','predicateSql','comment'])assert.throws(()=>createPhysicalIndex({...fixture.base,[field]:'\ud800'}),{message:'SCHEMA_INVALID'});
 for(const field of ['terms','include','options'])assert.throws(()=>createPhysicalIndex({...fixture.base,[field]:Array(1)}),{message:'SCHEMA_INVALID'});
 for(const prefixLength of [NaN,Infinity,-Infinity,undefined]){
  const value=structuredClone(fixture.base);value.terms[0].prefixLength=prefixLength;
  assert.throws(()=>createPhysicalIndex(value),{message:'SCHEMA_INVALID'});
 }
});
