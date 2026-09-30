import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {emitPhysicalDocument,parsePhysicalDocument} from '../dist/physical_document.js';
const empty=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/physical_graph_json.json',import.meta.url))).empty;
const limits=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/physical_envelope.json',import.meta.url))).limits;
const block=emitPhysicalDocument(empty);
for(const kind of ['bytes','lines','blocks'])for(const extra of [0,1])test(`${kind}-${extra}`,{timeout:15000},()=>{
 const n=limits[kind]+extra;
 const prefix=kind==='lines'?'\n'.repeat(n-(block.match(/\n/g)?.length??0)-1):kind==='blocks'?'```text\n```\n'.repeat(n-1):'';
 const suffix=kind==='bytes'?'x'.repeat(n-block.length):'';
 const source=prefix+block+suffix;
 if(extra)assert.throws(()=>parsePhysicalDocument(source),e=>e.message==='SCHEMA_INVALID'&&e.line===0&&e.path==='');
 else{const doc=parsePhysicalDocument(source);assert.deepEqual(doc.graph,empty);assert.equal(doc.prefix,prefix);assert.equal(doc.suffix,suffix);}
});
