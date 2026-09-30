import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPhysicalColumn} from '../dist/physical_column.js';

test('shared immutable physical column vectors preserve raw fields',{timeout:3000},async()=>{
  const fixture=JSON.parse(await readFile(new URL('../../../contracts/fixtures/physical_columns.json',import.meta.url),'utf8'));
  assert.equal(fixture.cases.length,25);assert.equal(new Set(fixture.cases.map(c=>c.id)).size,25);
  for(const c of fixture.cases){
    assert(c.id.length>0);
    const value={...structuredClone(fixture.base),...structuredClone(c.changes)};
    if(c.error){assert.throws(()=>createPhysicalColumn(value),{message:c.error});continue;}
    const column=createPhysicalColumn(value);assert.deepEqual(column,value);
    value.default.kind='changed';value.comment='changed';
    assert.notEqual(column.default.kind,'changed');assert.notEqual(column.comment,'changed');
    assert(Object.isFrozen(column)&&Object.isFrozen(column.default)&&Object.isFrozen(column.generation)&&Object.isFrozen(column.options));
    assert(column.options.every(Object.isFrozen));
  }
  assert.throws(()=>createPhysicalColumn({...fixture.base,typeSql:'x'.repeat(4097)}),{message:'SCHEMA_INVALID'});
  for(const changes of [
    {typeSql:'한'.repeat(1366)},{typeSql:'\ud800'},
    {options:Array.from({length:64},()=>({name:'option',value:'x'.repeat(1100)}))},
    {options:Array.from({length:65},()=>({name:'option',value:''}))},
    {options:Array(1)}
  ])assert.throws(()=>createPhysicalColumn({...fixture.base,...changes}),{message:'SCHEMA_INVALID'});
});
