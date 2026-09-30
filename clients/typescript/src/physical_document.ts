/** Internal until four-client, ownership and rendered-diagram checks pass. */
import {type PhysicalGraph,PhysicalGraphError} from './physical_graph.js';
import {parsePhysicalGraphJSON,emitPhysicalGraphJSON} from './physical_graph_json.js';
import {locatePhysicalEnvelope,PhysicalEnvelopeError} from './physical_envelope.js';
import {physicalProjection} from './physical_projection.js';

export class PhysicalDocumentError extends Error {
 readonly code='SCHEMA_INVALID';
 constructor(readonly line:number,readonly path=''){super('SCHEMA_INVALID');Object.freeze(this);}
}
export interface PhysicalDocument {
 readonly graph:PhysicalGraph;readonly prefix:string;readonly suffix:string;
 readonly newline:'\n'|'\r\n';readonly diagram:string;
}
function* lines(text:string):Generator<string> {
 for(let start=0;start<text.length;){
  const next=text.indexOf('\n',start),end=next<0?text.length:next;
  yield text.slice(start,end>start&&text[end-1]==='\r'?end-1:end);
  start=next<0?text.length:next+1;
 }
}
export function parsePhysicalDocument(source:unknown):PhysicalDocument {
 let ranges;
 try{ranges=locatePhysicalEnvelope(source);}catch(error){
  if(error instanceof PhysicalEnvelopeError)throw new PhysicalDocumentError(error.line);
  throw error;
 }
 const bytes=new TextEncoder().encode(source as string),decoder=new TextDecoder('utf-8',{fatal:true});
 const prefix=decoder.decode(bytes.subarray(0,ranges.start));
 const opening=decoder.decode(bytes.subarray(ranges.start,ranges.body));
 const body=decoder.decode(bytes.subarray(ranges.body,ranges.close));
 const suffix=decoder.decode(bytes.subarray(ranges.end));
 const newline=opening.endsWith('\r\n')?'\r\n':'\n';
 let line=1;for(const c of prefix+opening)if(c==='\n')line++;
 const input=lines(body);
 const expect=(expected:string)=>{if(input.next().value!==expected)throw new PhysicalDocumentError(line);line++;};
 expect('erDiagram');expect('%% orm:physical-json 1');
 const metadata=input.next().value;
 if(typeof metadata!=='string'||!metadata.startsWith('%% '))throw new PhysicalDocumentError(line);
 let graph:PhysicalGraph;
 try{graph=parsePhysicalGraphJSON(metadata.slice(3));}catch(error){
  if(error instanceof PhysicalGraphError||error instanceof Error&&error.message==='SCHEMA_INVALID'){
   const path=error instanceof PhysicalGraphError?error.path:'';
   throw new PhysicalDocumentError(line,path);
  }
  throw error;
 }
 line++;expect('%% orm:physical-json-end');
 const projection:string[]=['erDiagram'];
 for(const expected of physicalProjection(graph)){expect(expected);projection.push(expected);}
 if(!input.next().done)throw new PhysicalDocumentError(line);
 return Object.freeze({graph,prefix,suffix,newline,diagram:projection.join('\n')+'\n'});
}
export function emitPhysicalDocument(graph:PhysicalGraph,prefix='',suffix='',newline:'\n'|'\r\n'='\n'):string {
 if(typeof prefix!=='string'||typeof suffix!=='string'||newline!=='\n'&&newline!=='\r\n')throw new PhysicalDocumentError(0);
 if(prefix!==''&&!prefix.endsWith('\n'))throw new PhysicalDocumentError(0);
 const json=emitPhysicalGraphJSON(graph);
 const output=prefix+[
  '```mermaid orm-physical-v1','erDiagram','%% orm:physical-json 1',`%% ${json}`,
  '%% orm:physical-json-end',...physicalProjection(graph),'```','',
 ].join(newline)+suffix;
 // Verify emitted ownership and source limits, rather than repairing the source.
 let ranges;
 try{ranges=locatePhysicalEnvelope(output);}catch(error){if(error instanceof PhysicalEnvelopeError)throw new PhysicalDocumentError(error.line);throw error;}
 const bytes=new TextEncoder().encode(output);
 if(ranges.start!==new TextEncoder().encode(prefix).length||new TextDecoder().decode(bytes.subarray(ranges.end))!==suffix)throw new PhysicalDocumentError(0);
 return output;
}
