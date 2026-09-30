import {readFile} from 'node:fs/promises';
export const recordsFixture=JSON.parse(await readFile(new URL('../../../contracts/fixtures/physical_graph_records.json',import.meta.url),'utf8'));
export function recordScale(base,count){
 const indices=[],keys=[],checks=[];
 for(let i=0;i<count;i++){
  const index=structuredClone(base.indices[0]);index.id=`index-${i}`;index.tableId=`t-${i}`;index.terms[0].source.columnId=`c-${i}-1`;index.terms[1].source.columnId=`c-${i}-0`;
  const key=structuredClone(base.keys[0]);key.id=`key-${i}`;key.tableId=`t-${i}`;key.columns=[`c-${i}-1`,`c-${i}-0`];key.indexId=index.id;
  const check=structuredClone(base.checks[0]);check.id=`check-${i}`;check.tableId=`t-${i}`;check.expressionSql='"Column.0" > 0';
  indices.push(index);keys.push(key);checks.push(check);
 }
 return {indices,keys,checks};
}
