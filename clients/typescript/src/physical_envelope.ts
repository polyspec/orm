/** UTF-8 source ranges only; no validated schema or diagram is returned. */
export interface PhysicalEnvelope {readonly start:number;readonly body:number;readonly close:number;readonly end:number}
export class PhysicalEnvelopeError extends Error {
 constructor(readonly line:number){super('SCHEMA_INVALID');}
}
function utf8Size(text:string,start=0,end=text.length):number {
 let bytes=0;
 for(let i=start;i<end;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new PhysicalEnvelopeError(0);bytes+=4;}else if(c>=0xdc00&&c<=0xdfff)throw new PhysicalEnvelopeError(0);else bytes+=c<128?1:c<2048?2:3;}
 return bytes;
}
export function locatePhysicalEnvelope(input:unknown):PhysicalEnvelope {
 const fail=(line:number):never=>{throw new PhysicalEnvelopeError(line);};
 if(typeof input!=='string'||input.length>67108864||input.startsWith('\ufeff'))return fail(0);
 const source=input;if(utf8Size(source)>67108864)return fail(0);
 let lines=1;for(let i=0;i<source.length;i++){const c=source.charCodeAt(i);if(c===10)lines++;if(lines>200000||c===13&&source.charCodeAt(i+1)!==10)return fail(0);}
 let active='',run=0,opened=0,blocks=0,found=false,owned=false,byteStart=0;
 const result={start:0,body:0,close:0,end:0};
 for(let start=0,line=1;start<source.length;line++){
  const next=source.indexOf('\n',start),end=next<0?source.length:next+1;let contentEnd=end;
  if(contentEnd>start&&source[contentEnd-1]==='\n')contentEnd--;if(contentEnd>start&&source[contentEnd-1]==='\r')contentEnd--;
  const byteEnd=byteStart+utf8Size(source,start,end);
  let p=start;while(p<contentEnd&&p-start<4&&source[p]===' ')p++;
  if(p-start<=3&&p<contentEnd&&(source[p]==='`'||source[p]==='~')){
   const ch=source[p];let q=p;while(q<contentEnd&&source[q]===ch)q++;const length=q-p;
   let left=q,right=contentEnd;while(left<right&&(source[left]===' '||source[left]==='\t'))left++;while(right>left&&(source[right-1]===' '||source[right-1]==='\t'))right--;
   if(active){if(ch===active&&length>=run&&left===right){if(owned){result.close=byteStart;result.end=byteEnd;}active='';owned=false;}}
   else if(length>=3&&(ch!=='`'||!source.slice(q,contentEnd).includes('`'))){
    if(++blocks>4096)return fail(0);const info=source.slice(left,right);owned=p===start&&info.startsWith('mermaid orm-physical-');
    if(owned){if(info!=='mermaid orm-physical-v1'||found)return fail(line);found=true;result.start=byteStart;result.body=byteEnd;}
    active=ch;run=length;opened=line;
   }
  }
  start=end;byteStart=byteEnd;
 }
 if(active)return fail(opened);if(!found)return fail(0);return Object.freeze(result);
}
