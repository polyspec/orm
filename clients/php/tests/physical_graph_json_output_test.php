<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$started=hrtime(true);echo "RUN physical_graph_json_output\n";
$f=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_graph_json.json'),true,512,JSON_THROW_ON_ERROR);
$base=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_graph_records.json'),true,512,JSON_THROW_ON_ERROR)['base']['tables'][0];
foreach([$f['output']['acceptedTables'],$f['output']['rejectedTables']]as$count){
 $value=$f['empty'];$comment=str_repeat($f['output']['commentCharacter'],$f['output']['commentBytes']);for($i=0;$i<$count;$i++){$table=$base;$table['id']="t-$i";$table['identity']=[null,'main',"Table.$i",null];$table['comment']=$comment;foreach($table['columns']as$j=>$column)$table['columns'][$j]['id']="c-$i-$j";$value['tables'][]=$table;}
 $graph=Orm\PhysicalGraph::fromValue($value);try{$text=$graph->toJson();if($count!==$f['output']['acceptedTables']||strlen($text)>$f['bounds']['bytes']||Orm\PhysicalGraph::fromJson($text)->value()!==$value)throw new RuntimeException('Wrong output result');}catch(Orm\PhysicalGraphError$e){if($count!==$f['output']['rejectedTables']||$e->path()!==''||$e->getMessage()!=='SCHEMA_INVALID')throw new RuntimeException('Wrong output rejection');}unset($text,$value,$graph);
}
if(hrtime(true)-$started>15e9)throw new RuntimeException('Deadline exceeded');echo 'PASS physical_graph_json_output '.((hrtime(true)-$started)/1e6)." ms\n";
