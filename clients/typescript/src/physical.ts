/** Exact physical names; independent of logical model identifier rules. */
export type PhysicalParts=readonly [string|null,string|null,string,string|null];
export interface PhysicalIdentity {
  readonly parts:PhysicalParts;
  readonly key:string;
}

export function createPhysicalIdentity(parts:PhysicalParts):PhysicalIdentity {
  const invalid=()=>{throw new Error('SCHEMA_INVALID');};
  if(!Array.isArray(parts)||parts.length!==4||typeof parts[2]!=='string')invalid();
  const encoder=new TextEncoder();
  const tokens=Array.from(parts,part=>{
    if(part===null)return '-';
    if(typeof part!=='string'||!part.length||/[\x00-\x1f\x7f]/.test(part))invalid();
    for(const character of part){
      const point=character.codePointAt(0)!;
      if(point>=0xd800&&point<=0xdfff)invalid();
    }
    const bytes=encoder.encode(part);
    if(bytes.length>1024)invalid();
    return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
  });
  return Object.freeze({parts:Object.freeze([...parts]) as PhysicalParts,key:`p1:${tokens.join('.')}`});
}
