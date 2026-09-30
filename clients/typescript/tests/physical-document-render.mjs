import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {root,serve} from '../../../scripts/docs/lib.mjs';
import {emitPhysicalDocument,parsePhysicalDocument} from '../dist/physical_document.js';

test('physical projection renders actual hostile labels and parallel FKs',{timeout:30000},async()=>{
 const graph=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/physical_graph_records.json',import.meta.url))).base;
 graph.tables[0].identity[2]='Child " \\ <script> ``` 😺';
 graph.tables[0].columns[0].name='First " <!-- -->';
 graph.tables[0].columns[0].typeSql='INTEGER /* " \\ */';
 graph.foreignKeys.push({...structuredClone(graph.foreignKeys[0]),id:'fk-2',name:'FK.Second'});
 const diagram=parsePhysicalDocument(emitPhysicalDocument(graph)).diagram;
 const server=await serve(root);let browser;
 try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();await page.goto(`${server.origin}/README.md`);
  const result=await page.evaluate(async({origin,diagram})=>{
   document.body.replaceChildren();
   const {default:mermaid}=await import(`${origin}/node_modules/mermaid/dist/mermaid.esm.min.mjs`);
   mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,htmlLabels:false});
   await mermaid.parse(diagram);
   const {svg}=await mermaid.render('physical-joint-proof',diagram);
   const element=new DOMParser().parseFromString(svg,'image/svg+xml').documentElement;
   const box=element.getAttribute('viewBox').split(/[ ,]+/).map(Number);
   return {width:box[2],height:box[3],text:element.textContent,script:element.querySelector('script')!==null};
  },{origin:server.origin,diagram});
  assert(result.width>0&&result.height>0);assert.equal(result.script,false);
  assert(result.text.includes('unverified FK fk-1'));assert(result.text.includes('unverified FK fk-2'));
  assert(result.text.includes('😺'));assert(result.text.includes('␛0022'));
 }finally{if(browser)await browser.close();await server.close();}
});
