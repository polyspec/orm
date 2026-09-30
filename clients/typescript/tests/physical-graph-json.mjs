import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as api from '../dist/physical_graph_json.js';
import {decodePhysicalJSON} from '../dist/physical_json.js';
import {createPhysicalGraph} from '../dist/physical_graph.js';
const fixture=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/physical_graph_json.json',import.meta.url)));
const records=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/physical_graph_records.json',import.meta.url))).base;
test('strict physical JSON',{timeout:15000},()=>{
 assert.equal(fixture.cases.length,30);
 for(const c of fixture.cases){if(c.ok)assert.deepEqual(api.parsePhysicalGraphJSON(c.text),fixture.empty);else assert.throws(()=>api.parsePhysicalGraphJSON(c.text),e=>e.message==='SCHEMA_INVALID'&&e.path===c.path,c.id);}
 for(const [i,version]of fixture.versions.entries()){const text=JSON.stringify(fixture.empty).replace('"version":1',`"version":${version}`);if(i<4)assert.deepEqual(api.parsePhysicalGraphJSON(text),fixture.empty);else assert.throws(()=>api.parsePhysicalGraphJSON(text),e=>e.message==='SCHEMA_INVALID'&&e.path==='');}
 const value=structuredClone(records);value.tables[0].comment='</script> <!-- --> " \\ 😺 �';
 const first=api.parsePhysicalGraphJSON(JSON.stringify(value));assert.deepEqual(first,value);const text=api.emitPhysicalGraphJSON(first);assert.deepEqual(api.parsePhysicalGraphJSON(text),value);assert.equal(api.emitPhysicalGraphJSON(api.parsePhysicalGraphJSON(text)),text);
 for(const text of [' '.repeat(fixture.bounds.bytes+1),'['.repeat(17)+']'.repeat(17),'['+'0,'.repeat(fixture.bounds.nodes)+ '0]'])assert.throws(()=>api.parsePhysicalGraphJSON(text),e=>e.message==='SCHEMA_INVALID'&&e.path==='');
 assert.throws(()=>api.parsePhysicalGraphJSON(new Uint8Array([0xff])),e=>e.message==='SCHEMA_INVALID');
 assert.throws(()=>api.parsePhysicalGraphJSON('\ud800'),e=>e.message==='SCHEMA_INVALID');
});
test('physical JSON output byte limit',{timeout:15000},()=>{
 for(const count of [fixture.output.acceptedTables,fixture.output.rejectedTables]){const graph=createPhysicalGraph({...fixture.empty,tables:Array.from({length:count},(_,i)=>({...structuredClone(records.tables[0]),id:`t-${i}`,identity:[null,'main',`Table.${i}`,null],comment:fixture.output.commentCharacter.repeat(fixture.output.commentBytes),columns:records.tables[0].columns.map((column,j)=>({...structuredClone(column),id:`c-${i}-${j}`}))}))});
 if(count===fixture.output.acceptedTables){const text=api.emitPhysicalGraphJSON(graph);assert(new TextEncoder().encode(text).length<=fixture.bounds.bytes);assert.deepEqual(api.parsePhysicalGraphJSON(text),graph);}else assert.throws(()=>api.emitPhysicalGraphJSON(graph),e=>e.message==='SCHEMA_INVALID'&&e.path==='');}
});
for(const c of [{id:'byte-limit',text:' '.repeat(fixture.bounds.bytes-1)+'0',ok:true},{id:'byte-excess',text:' '.repeat(fixture.bounds.bytes)+'0',ok:false},{id:'depth-limit',text:'['.repeat(16)+'0'+']'.repeat(16),ok:true},{id:'depth-excess',text:'['.repeat(17)+'0'+']'.repeat(17),ok:false},{id:'node-limit',text:'['+'0,'.repeat(2999998)+'0]',ok:true},{id:'node-excess',text:'['+'0,'.repeat(2999999)+'0]',ok:false}])test(c.id,{timeout:15000},()=>{if(c.ok)assert.doesNotThrow(()=>decodePhysicalJSON(c.text));else assert.throws(()=>decodePhysicalJSON(c.text),e=>e.message==='SCHEMA_INVALID'&&e.path==='');});
