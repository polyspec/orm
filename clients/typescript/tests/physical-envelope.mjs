import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {locatePhysicalEnvelope} from '../dist/physical_envelope.js';
const f=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/physical_envelope.json',import.meta.url)));
assert.equal(f.cases.length,21);
for(const c of f.cases)test(c.id,{timeout:15000},()=>{
 if(c.reject){assert.throws(()=>locatePhysicalEnvelope(c.text),e=>e.message==='SCHEMA_INVALID'&&e.line===c.line);return;}
 const r=locatePhysicalEnvelope(c.text),b=Buffer.from(c.text);
 assert.equal(b.subarray(0,r.start).toString(),c.before);assert.equal(b.subarray(r.body,r.close).toString(),c.body);assert.equal(b.subarray(r.end).toString(),c.after);
});
const block='```mermaid orm-physical-v1\n```\n';
for(const [kind,max]of Object.entries(f.limits))for(const excess of [0,1])test(`${kind}-${excess}`,{timeout:15000},()=>{
 const n=max+excess,text=kind==='bytes'?'x'.repeat(n-block.length-1)+'\n'+block:kind==='lines'?'\n'.repeat(n-3)+block:'```text\n```\n'.repeat(n-1)+block;
 if(excess)assert.throws(()=>locatePhysicalEnvelope(text),e=>e.message==='SCHEMA_INVALID'&&e.line===0);else assert.doesNotThrow(()=>locatePhysicalEnvelope(text));
});
test('invalid-encoding',{timeout:15000},()=>{for(const text of ['\ud800','\udc00',new Uint8Array([255])])assert.throws(()=>locatePhysicalEnvelope(text),e=>e.message==='SCHEMA_INVALID'&&e.line===0);});
