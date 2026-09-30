const rawEnd=/<\/(?:[pP][rR][eE]|[sS][cC][rR][iI][pP][tT]|[sS][tT][yY][lL][eE]|[tT][eE][xX][tT][aA][rR][eE][aA])>/g;
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
