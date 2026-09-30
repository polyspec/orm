import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhysicalGraph,PhysicalGraphError} from '../dist/physical_graph.js';
import {recordsFixture as fixture} from './physical-graph-records-fixture.mjs';
function failure(value,path){assert.throws(()=>createPhysicalGraph(value),e=>e instanceof PhysicalGraphError&&e.message==='SCHEMA_INVALID'&&e.path===path);}
test('physical graph resolves index key and CHECK records',{timeout:15000},async(t)=>{
 assert.equal(fixture.cases.length,35);assert.equal(fixture.duplicates.length,3);assert.equal(fixture.counts.length,3);assert.equal(fixture.bytes.length,3);assert.equal(new Set(fixture.cases.map(c=>c.id)).size,35);
 assert.deepEqual(fixture.scale,{tables:2000,indices:2000,keys:2000,checks:2000});
 for(const c of fixture.cases){assert(c.id);await t.test(c.id,{timeout:1000},()=>{
  const value=structuredClone(fixture.base);if(c.drop)delete value[c.drop];for(const change of c.changes){let target=value;for(const key of change.path.slice(0,-1))target=target[key];target[change.path.at(-1)]=structuredClone(change.value);}
  if(Object.hasOwn(c,'error')){failure(value,c.error);return;}
  const graph=createPhysicalGraph(value);assert.deepEqual(graph,value);const frozen=value=>{if(value!==null&&typeof value==='object'){assert(Object.isFrozen(value));for(const child of Object.values(value))frozen(child);}};frozen(graph);
  if(value.indices.length){value.indices[0].terms[0].order='changed';value.checks[0].comment='changed';assert.notEqual(graph.indices[0].terms[0].order,'changed');assert.notEqual(graph.checks[0].comment,'changed');}
 });}
 for(const c of fixture.duplicates){const value=structuredClone(fixture.base),record=structuredClone(value[c.field][0]);record.id='another';for(const key of ['name','kind','indexId'])if(Object.hasOwn(c,key))record[key]=c[key];value[c.field].push(record);failure(value,c.error);}
 for(const c of fixture.counts)failure({...fixture.base,[c.field]:Array(c.count)},c.error);
 failure({...fixture.base,foreignKeys:Array(20000),indices:Array(20000),keys:Array(20000)},'');
 for(const c of fixture.bytes){const value=structuredClone(fixture.base),prototype=value[c.field][0];value[c.field]=Array.from({length:c.count},(_,i)=>({...structuredClone(prototype),id:`record-${i}`,name:null,comment:'x'.repeat(c.commentBytes),...(c.field==='keys'?{kind:'unique',indexId:null}:{})}));if(c.field==='indices')value.keys=[];failure(value,c.error);}
 for(const field of ['indices','keys','checks'])failure({...fixture.base,[field]:Array(1)},`/${field}/0`);
});
