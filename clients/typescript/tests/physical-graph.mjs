import test from 'node:test';
import {recordsFixture,recordScale} from './physical-graph-records-fixture.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as api from '../dist/index.js';

const fixture=JSON.parse(await readFile(new URL('../../../contracts/fixtures/physical_graphs.json',import.meta.url),'utf8'));
function failure(value,path){
 assert.throws(()=>api.createPhysicalGraph(value),error=>error instanceof api.PhysicalGraphError&&error.message==='SCHEMA_INVALID'&&error.path===path,`expected ${path}`);
}
test('physical graph shared vectors and detached immutable snapshots',{timeout:15000},()=>{
 assert.equal(typeof api.createPhysicalGraph,'function');
 assert.equal(fixture.cases.length,28);assert.equal(new Set(fixture.cases.map(c=>c.id)).size,28);
 for(const c of fixture.cases){
  assert(c.id.length>0);const value=structuredClone(fixture.base);
  for(const change of c.changes){let target=value;for(const key of change.path.slice(0,-1))target=target[key];target[change.path.at(-1)]=structuredClone(change.value);}
  if(Object.hasOwn(c,'error')){failure(value,c.error);continue;}
  const graph=api.createPhysicalGraph(value);assert.deepEqual(graph,value);
  const visit=value=>{if(value!==null&&typeof value==='object'){assert(Object.isFrozen(value));for(const child of Object.values(value))visit(child);}};visit(graph);
  if(value.tables.length){value.tables[0].columns[0].name='changed';value.tables[0].identity[2]='changed';assert.notEqual(graph.tables[0].identity[2],'changed');assert.notEqual(graph.tables[0].columns[0].name,'changed');}
 }
});
test('physical graph rejects sparse arrays count excess cycles and duplicate FK names',{timeout:15000},()=>{
 const base=structuredClone(fixture.base);
 failure({...base,tables:Array(1)},'/tables/0');
 failure({...base,foreignKeys:Array(1)},'/foreignKeys/0');
 failure({...base,tables:Array(4097)},'/tables');
 failure({...base,foreignKeys:Array(20001)},'/foreignKeys');
 const duplicate=structuredClone(base.foreignKeys[0]);duplicate.id='another';failure({...base,foreignKeys:[...base.foreignKeys,duplicate]},'/foreignKeys/1/name');
 duplicate.name=null;assert.doesNotThrow(()=>api.createPhysicalGraph({...base,foreignKeys:[...base.foreignKeys,duplicate]}));
 const reverse=structuredClone(base.foreignKeys[0]);reverse.id='reverse';reverse.tableId='parent';reverse.columns=['parent-c1','parent-c2'];reverse.target={tableId:'child',columns:['child-c1','child-c2']};
 assert.doesNotThrow(()=>api.createPhysicalGraph({...base,foreignKeys:[...base.foreignKeys,reverse]}));
 const cyclic=structuredClone(base);cyclic.tables[0].columns[0].options=[{name:'cycle',value:cyclic}];failure(cyclic,'/tables/0/columns/0');
 const oversized=structuredClone(base);oversized.tables[0].columns=Array(4097);failure(oversized,'/tables/0/columns');
});
test('physical graph retains 2000 tables 60000 columns and 10000 connected FKs',{timeout:15000},()=>{
 const started=performance.now();const {tables:count,columnsPerTable,foreignKeys:fkCount}=fixture.scale;
 assert.equal(count,2000);assert.equal(columnsPerTable,30);assert.equal(fkCount,10000);
 const tables=Array.from({length:count},(_,i)=>({...structuredClone(fixture.base.tables[0]),id:`t-${i}`,identity:[null,'main',`Table.${i}`,null],columns:Array.from({length:columnsPerTable},(_,j)=>({...structuredClone(fixture.base.tables[0].columns[0]),id:`c-${i}-${j}`,name:`Column.${j}`}))}));
 const foreignKeys=Array.from({length:fkCount},(_,i)=>{const source=Math.floor(i/5),target=(source+i%5)%count;return {...structuredClone(fixture.base.foreignKeys[0]),id:`fk-${i}`,name:`FK.${i%5}`,tableId:`t-${source}`,columns:[`c-${source}-0`,`c-${source}-1`],target:{tableId:`t-${target}`,columns:[`c-${target}-1`,`c-${target}-0`]}};});
 const records=recordScale(recordsFixture.base,count);const generated=performance.now();const graph=api.createPhysicalGraph({...fixture.base,tables,foreignKeys,...records});const validated=performance.now();
 for(const field of ['indices','keys','checks']){assert.equal(graph[field].length,2000);assert.deepEqual(graph[field],records[field]);}
 assert.equal(graph.tables.length,count);assert.equal(graph.tables.reduce((sum,t)=>sum+t.columns.length,0),60000);assert.equal(graph.foreignKeys.length,fkCount);
 for(let i=0;i<fkCount;i++){assert.equal(graph.foreignKeys[i].id,`fk-${i}`);assert.equal(graph.foreignKeys[i].target.columns[0],foreignKeys[i].target.columns[0]);}
 tables[0].columns[0].name='changed';assert.equal(graph.tables[0].columns[0].name,'Column.0');
 console.log(JSON.stringify({event:'physical-graph-retention',tables:count,columns:60000,foreignKeys:fkCount,indices:2000,keys:2000,checks:2000,generateMs:generated-started,validateMs:validated-generated,elapsedMs:performance.now()-started}));
});
test('physical graph shared count and byte limits',{timeout:15000},()=>{
 assert.equal(fixture.limits.length,5);
 for(const limit of fixture.limits){
  const comment='x'.repeat(limit.commentBytes);
  const tables=Array.from({length:limit.tables},(_,i)=>({...fixture.base.tables[0],id:`t-${i}`,identity:[null,'main',`Table.${i}`,null],columns:Array.from({length:limit.columns},(_,j)=>({...fixture.base.tables[0].columns[0],id:`c-${i}-${j}`,name:`Column.${j}`,comment}))}));
  failure({...fixture.base,tables,foreignKeys:Array(limit.foreignKeys??0).fill(fixture.base.foreignKeys[0])},limit.error);
 }
});
