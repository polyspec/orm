import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const base=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/physical_graph_records.json',import.meta.url))).base;
const fixture=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/physical_document.json',import.meta.url)));
test('joint physical document preserves metadata and rejects diagram contradictions',{timeout:15000},async()=>{
 const api=await import('../dist/physical_document.js');
 const display=await import('../dist/physical_projection.js');
 for(const value of fixture.displayStrings)assert.equal(display.restorePhysicalDisplay(display.physicalDisplay(value)),value);
 const graph=structuredClone(base);
 graph.tables[0].identity[2]=fixture.tableName;
 graph.tables[0].columns[0].name=fixture.columnName;
 graph.tables[0].columns[0].comment=fixture.columnComment;
 graph.tables[0].columns[0].typeSql=fixture.typeSql;
 graph.foreignKeys.push({...structuredClone(graph.foreignKeys[0]),id:'fk-2',name:'FK.Second'});
 const prefix='# Design 😺\r\n\r\n',suffix='\r\nAfter\r\n';
 const source=api.emitPhysicalDocument(graph,prefix,suffix,'\r\n');
 const doc=api.parsePhysicalDocument(source);
 assert.deepEqual(doc.graph,graph);assert.equal(doc.prefix,prefix);assert.equal(doc.suffix,suffix);
 assert.equal(api.emitPhysicalDocument(doc.graph,doc.prefix,doc.suffix,doc.newline),source);
 assert.equal(doc.diagram.split('\n').filter(line=>line.includes(' : ')).length,2);
 assert.equal(fixture.mutations.length,7);
 for(const c of fixture.mutations){assert(source.includes(c.from));assert.throws(()=>api.parsePhysicalDocument(source.replace(c.from,c.to)),e=>e.message==='SCHEMA_INVALID'&&e.line===c.line&&e.path===(c.path??''),c.id);}
 assert.throws(()=>api.parsePhysicalDocument(source+source),e=>e.message==='SCHEMA_INVALID');
 assert.throws(()=>api.emitPhysicalDocument(graph,'No newline'),e=>e.message==='SCHEMA_INVALID');
 assert.throws(()=>api.emitPhysicalDocument(graph,'<!--\n'),e=>e.message==='SCHEMA_INVALID');
 const empty={...base,tables:[],foreignKeys:[],indices:[],keys:[],checks:[]};
 assert.deepEqual(api.parsePhysicalDocument(api.emitPhysicalDocument(empty)).graph,empty);
});
