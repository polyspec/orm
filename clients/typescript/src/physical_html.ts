const rawEnd=/<\/(?:[pP][rR][eE]|[sS][cC][rR][iI][pP][tT]|[sS][tT][yY][lL][eE]|[tT][eE][xX][tT][aA][rR][eE][aA])>/g;
const blockTags=new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));
export function physicalHTMLBlankStart(source:string,p:number,end:number):boolean {
 if(end-p<2||source[p]!=='<')return false;p++;if(source[p]==='/')p++;const start=p;
 while(p<end&&/[A-Za-z0-9]/.test(source[p])){if(++p-start>10)return false;}
 if(!blockTags.has(source.slice(start,p).toLowerCase()))return false;
 return p===end||' \t>'.includes(source[p])||source[p]==='/'&&p+1<end&&source[p+1]==='>';
}
/** Internal: null for ordinary text, -1 for an unfinished explicit HTML block. */
export function physicalHTMLEnd(source:string,p:number,end:number):number|null {
 if(p===end||source[p]!=='<')return null;
 const starts=(text:string)=>p+text.length<=end&&source.startsWith(text,p);
 let delimiter:string;
 if(starts('<!--'))delimiter='-->';
 else if(starts('<?'))delimiter='?>';
 else if(starts('<![CDATA['))delimiter=']]>';
 else if(end-p>2&&source[p+1]==='!'&&/[A-Za-z]/.test(source[p+2]))delimiter='>';
 else {
  const raw=['pre','script','style','textarea'].some(tag=>{const n=tag.length+1;return end-p>=n&&source.slice(p+1,p+n).toLowerCase()===tag&&(p+n===end||' \t>'.includes(source[p+n]));});
  if(!raw)return null;rawEnd.lastIndex=p;const match=rawEnd.exec(source);return match?match.index+match[0].length:-1;
 }
 const close=source.indexOf(delimiter,p);return close<0?-1:close+delimiter.length;
}
