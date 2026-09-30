import {createPhysicalGraph,type PhysicalGraph} from './physical_graph.js';
import {decodePhysicalJSON,encodePhysicalJSON} from './physical_json.js';
export function parsePhysicalGraphJSON(text:unknown):PhysicalGraph{return createPhysicalGraph(decodePhysicalJSON(text));}
export function emitPhysicalGraphJSON(graph:PhysicalGraph):string{return encodePhysicalJSON(createPhysicalGraph(graph));}
