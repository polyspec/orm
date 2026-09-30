<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
require __DIR__.'/physical_graph_records_fixture.php';
$started=hrtime(true);echo "RUN physical_graph_records\n";$fixture=physicalGraphRecordFixture();
if(count($fixture['cases'])!==35||count($fixture['duplicates'])!==3||count($fixture['counts'])!==3||count($fixture['bytes'])!==3)throw new RuntimeException('Missing graph record cases');
if($fixture['scale']!==['tables'=>2000,'indices'=>2000,'keys'=>2000,'checks'=>2000])throw new RuntimeException('Changed record scale criterion');
$seen=[];$expect=static function(array $value,string $path):void{try{Orm\PhysicalGraph::fromValue($value);throw new RuntimeException('Expected rejection');}catch(Orm\PhysicalGraphError $error){if($error->getMessage()!=='SCHEMA_INVALID'||$error->path()!==$path)throw new RuntimeException('Wrong graph error path: '.$error->path());}};
foreach($fixture['cases'] as $case){
 $id=$case['id'];if($id===''||isset($seen[$id]))throw new RuntimeException('Invalid case ID');$seen[$id]=true;$caseStarted=hrtime(true);echo "RUN $id\n";
 $value=$fixture['base'];if(isset($case['drop']))unset($value[$case['drop']]);
 foreach($case['changes'] as $change){$target=&$value;foreach(array_slice($change['path'],0,-1) as $key)$target=&$target[$key];$target[$change['path'][count($change['path'])-1]]=$change['value'];unset($target);}
 if(array_key_exists('error',$case))$expect($value,$case['error']);else{
  $graph=Orm\PhysicalGraph::fromValue($value);if($graph->value()!==$value)throw new RuntimeException('Changed graph record');
  if(count($value['indices'])>0){$value['indices'][0]['terms'][0]['order']='changed';$copy=$graph->value();$copy['checks'][0]['comment']='changed';if($graph->value()['indices'][0]['terms'][0]['order']==='changed'||$graph->value()['checks'][0]['comment']==='changed')throw new RuntimeException('Aliased graph record');}
 }
 if(hrtime(true)-$caseStarted>1e9)throw new RuntimeException('Case deadline exceeded');echo "PASS $id ".((hrtime(true)-$caseStarted)/1e6)." ms\n";
}
foreach($fixture['duplicates'] as $case){$value=$fixture['base'];$field=$case['field'];$record=$value[$field][0];$record['id']='another';foreach(['name','kind','indexId'] as $name)if(array_key_exists($name,$case))$record[$name]=$case[$name];$value[$field][]=$record;$expect($value,$case['error']);echo 'PASS '.$case['id']."\n";}
foreach($fixture['counts'] as $case){$value=$fixture['base'];$value[$case['field']]=array_fill(0,$case['count'],null);$expect($value,$case['error']);echo 'PASS '.$case['field']."-count\n";}
$value=$fixture['base'];foreach(['foreignKeys','indices','keys'] as $field)$value[$field]=array_fill(0,20000,null);$expect($value,'');
foreach($fixture['bytes'] as $case){$value=$fixture['base'];$field=$case['field'];$prototype=$value[$field][0];$records=[];$comment=str_repeat('x',$case['commentBytes']);for($i=0;$i<$case['count'];$i++){$record=$prototype;$record['id']="record-$i";$record['name']=null;$record['comment']=$comment;if($field==='keys'){$record['kind']='unique';$record['indexId']=null;}$records[]=$record;}$value[$field]=$records;if($field==='indices')$value['keys']=[];$expect($value,$case['error']);echo "PASS $field-string-budget\n";unset($value,$records);}
$value=$fixture['base'];$order='original';$comment='original';$value['indices'][0]['terms'][0]['order']='desc';$value['indices'][0]['terms'][0]['collationSql']=&$order;$value['checks'][0]['comment']=&$comment;
$graph=Orm\PhysicalGraph::fromValue($value);$order='changed';$comment='changed';if($graph->value()['indices'][0]['terms'][0]['collationSql']!=='original'||$graph->value()['checks'][0]['comment']!=='original')throw new RuntimeException('Referenced graph record input');
if(hrtime(true)-$started>15e9)throw new RuntimeException('Records deadline exceeded');echo 'PASS physical_graph_records '.((hrtime(true)-$started)/1e6)." ms\n";
