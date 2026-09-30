import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPhysicalIdentity} from '../dist/physical.js';

test('shared physical identity vectors and immutable exact components',{timeout:3000},async()=>{
  const cases=JSON.parse(await readFile(new URL('../../../contracts/fixtures/physical_identities.json',import.meta.url),'utf8'));
  assert.equal(cases.length,10);assert.equal(new Set(cases.map(c=>c.id)).size,10);
  assert(cases.every(c=>typeof c.id==='string'&&c.id.length>0));
  for(const c of cases){
    if(c.error){assert.throws(()=>createPhysicalIdentity(c.parts),error=>error.message===c.error);continue;}
    const identity=createPhysicalIdentity(c.parts);
    assert.equal(identity.key,c.key);assert.deepEqual(identity.parts,c.parts);
    c.parts[2]='changed';assert.notEqual(identity.parts[2],'changed');
    assert(Object.isFrozen(identity)&&Object.isFrozen(identity.parts));
  }
  for(const name of ['x'.repeat(1025),'한'.repeat(342),'\ud800'])assert.throws(()=>createPhysicalIdentity([null,null,name,null]),{message:'SCHEMA_INVALID'});
  assert.doesNotThrow(()=>createPhysicalIdentity([null,null,'x'.repeat(1024),null]));
  const sparse=Array(4);sparse[2]='table';
  assert.throws(()=>createPhysicalIdentity(sparse),{message:'SCHEMA_INVALID'});
});
