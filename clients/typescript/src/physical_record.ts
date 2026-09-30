/** Shared validation for decoded physical records; not an execution API. */
export function invalid():never {throw new Error('SCHEMA_INVALID');}
export function shape(value:unknown,fields:readonly string[]):Record<string,unknown>{
 if(value===null||typeof value!=='object'||Array.isArray(value))invalid();
 const record=value as Record<string,unknown>;
 if(Object.keys(record).length!==fields.length||fields.some(field=>!Object.hasOwn(record,field)))invalid();return record;
}
export class PhysicalRecord{
 private bytes=0;private encoder=new TextEncoder();
 text(value:unknown,min:number,max:number):string{
  if(typeof value!=='string'||value.length>max||value.includes('\0'))invalid();
  for(const char of value){const point=char.codePointAt(0)!;if(point>=0xd800&&point<=0xdfff)invalid();}
  const size=this.encoder.encode(value).length;if(size<min||size>max||(this.bytes+=size)>65536)invalid();return value;
 }
 id(value:unknown):string{const id=this.text(value,1,128);if(!/^[A-Za-z0-9_-]+$/.test(id))invalid();return id;}
 ids(value:unknown):readonly string[]{
  if(!Array.isArray(value)||!value.length||value.length>64)invalid();const seen=new Set<string>();
  return Object.freeze(Array.from(value,entry=>{const id=this.id(entry);if(seen.has(id))invalid();seen.add(id);return id;}));
 }
 options(value:unknown):readonly Readonly<{name:string;value:string}>[]{
  if(!Array.isArray(value)||value.length>64)invalid();
  return Object.freeze(Array.from(value,option=>{const entry=shape(option,['name','value']);return Object.freeze({name:this.text(entry.name,1,128),value:this.text(entry.value,0,4096)});}));
 }
}
