import {PhysicalGraphError} from './physical_graph.js';
const maxBytes=32*1024*1024;
function fail():never{throw new PhysicalGraphError('');}
function wellFormed(text:string):boolean{for(const char of text){const point=char.codePointAt(0)!;if(point>=0xd800&&point<=0xdfff)return false;}return true;}
/** Scan before general decoding so duplicates and rounded numbers cannot disappear. */
export function decodePhysicalJSON(input:unknown):unknown{
 if(typeof input!=='string'||input.length>maxBytes||!wellFormed(input)||new TextEncoder().encode(input).length>maxBytes)fail();
 const text=input;let pos=0,nodes=0;
 const whitespace=()=>{while(pos<text.length&&' \r\n\t'.includes(text[pos]))pos++;};
 const string=():string=>{
  const start=pos;if(text[pos++]!=='"')fail();
  while(pos<text.length){const c=text[pos++];if(c==='"'){let value:string;try{value=JSON.parse(text.slice(start,pos));}catch{fail();}if(!wellFormed(value))fail();return value;}if(c==='\\'){if(pos===text.length)fail();pos++;}else if(c<' ')fail();}
  return fail();
 };
 const number=()=>{
  const start=pos;while(pos<text.length&&!' \r\n\t,]}'.includes(text[pos]))pos++;
  const token=text.slice(start,pos);if(token.length>64||!/^\-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token))fail();
  const [mantissa,exponent='0']=token.replace(/^-/,'').toLowerCase().split('e');
  const [whole,fraction='']=mantissa.split('.');let digits=(whole+fraction).replace(/^0+/,'');if(!digits)return;
  const shift=Number(exponent)-fraction.length;if(!Number.isSafeInteger(shift)||Math.abs(shift)>64)fail();
  if(shift<0){const remove=-shift;if(remove>digits.length||!/^0*$/.test(digits.slice(-remove)))fail();digits=digits.slice(0,-remove);}else{if(digits.length+shift>16)fail();digits+='0'.repeat(shift);}
  if(digits.length>16||(digits.length===16&&digits>'9007199254740991'))fail();
 };
 const value=(depth:number):void=>{
  whitespace();if(++nodes>3000000)fail();const c=text[pos];
  if(c==='{'||c==='['){if(depth>=16)fail();const object=c==='{',close=object?'}':']',keys=new Set<string>();pos++;whitespace();if(text[pos]===close){pos++;return;}
   for(;;){if(object){whitespace();const key=string();if(keys.has(key))fail();keys.add(key);whitespace();if(text[pos++]!==':')fail();}value(depth+1);whitespace();if(text[pos]===close){pos++;return;}if(text[pos++]!==',')fail();}
  }
  if(c==='"'){string();return;}
  for(const literal of ['true','false','null'])if(text.startsWith(literal,pos)){pos+=literal.length;return;}
  if(c==='-'||(c>='0'&&c<='9')){number();return;}fail();
 };
 value(0);whitespace();if(pos!==text.length)fail();
 try{return JSON.parse(text);}catch{return fail();}
}
export function encodePhysicalJSON(value:unknown):string{
 let text:string;try{text=JSON.stringify(value);}catch{return fail();}
 if(text===undefined||text.length>maxBytes||new TextEncoder().encode(text).length>maxBytes)fail();return text;
}
