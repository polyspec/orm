/** Deterministic display only. Physical values and semantics stay in metadata. */
import type {PhysicalGraph} from './physical_graph.js';

function alias(prefix:string,id:string):string {
 return prefix+Array.from(id,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
}
export function physicalDisplay(text:string):string {
 return text.replace(/[\x00-\x1f\x7f"\\<>&#`%\[\]{}␛]/g,c=>'␛'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export function restorePhysicalDisplay(text:string):string {
 return text.replace(/␛([0-9a-f]{4})/g,(_,hex:string)=>String.fromCharCode(parseInt(hex,16)));
}
export function* physicalProjection(graph:PhysicalGraph):Generator<string> {
 yield '%% Multiplicity and identifying status are unverified display conventions.';
 for(const table of graph.tables){
  const quote=physicalDisplay('"');
  const label=physicalDisplay('[')+table.identity.slice(0,3).map(part=>part===null?'null':quote+physicalDisplay(part)+quote).join(',')+physicalDisplay(']');
  yield `    ${alias('T_',table.id)}["${label}"] {`;
  for(const column of table.columns){
   yield `        physical ${alias('C_',column.id)} "${physicalDisplay(column.name)} | ${physicalDisplay(column.typeSql)}"`;
  }
  yield '    }';
 }
 for(const fk of graph.foreignKeys){
  yield `%% FK ${fk.id} ${fk.columns.map((column,i)=>`${column}->${fk.target.columns[i]}`).join(',')}`;
  yield `    ${alias('T_',fk.tableId)} }o..o{ ${alias('T_',fk.target.tableId)} : "unverified FK ${fk.id}"`;
 }
}
