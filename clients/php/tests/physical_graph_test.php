<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
require __DIR__.'/physical_graph_records_fixture.php';
$started=hrtime(true);echo "RUN physical_graph\n";
$fixture=json_decode(file_get_contents(dirname(__DIR__,3).'/contracts/fixtures/physical_graphs.json'),true,512,JSON_THROW_ON_ERROR);
if(count($fixture['cases'])!==28)throw new RuntimeException('Missing graph vectors');$seen=[];
foreach($fixture['cases']as$case){
 if($case['id']===''||isset($seen[$case['id']]))throw new RuntimeException('Invalid vector ID');$seen[$case['id']]=true;
 $value=$fixture['base'];foreach($case['changes']as$change){$target=&$value;foreach(array_slice($change['path'],0,-1)as$key)$target=&$target[$key];$target[$change['path'][count($change['path'])-1]]=$change['value'];unset($target);}
 try{$graph=Orm\PhysicalGraph::fromValue($value);}
 catch(Orm\PhysicalGraphError$error){if(!array_key_exists('error',$case)||$error->getMessage()!=='SCHEMA_INVALID'||$error->path()!==$case['error'])throw$error;continue;}
 if(array_key_exists('error',$case)||$graph->value()!==$value)throw new RuntimeException('Changed graph fields');
 $copy=$graph->value();$copy['dialectVersion']='changed';$value['dialectVersion']='changed';if($graph->value()['dialectVersion']==='changed')throw new RuntimeException('Aliased graph');
}
$reference='original';$value=$fixture['base'];$value['tables'][0]['columns'][0]['comment']=&$reference;$graph=Orm\PhysicalGraph::fromValue($value);$reference='changed';if($graph->value()['tables'][0]['columns'][0]['comment']!=='original')throw new RuntimeException('Nested graph input reference retained');
if($fixture['scale']!==['tables'=>2000,'columnsPerTable'=>30,'foreignKeys'=>10000])throw new RuntimeException('Changed stress criterion');
$scaleStarted=hrtime(true);$tables=[];$fks=[];
for($i=0;$i<2000;$i++){$table=$fixture['base']['tables'][0];$table['id']="t-$i";$table['identity']=[null,'main',"Table.$i",null];$table['columns']=[];for($j=0;$j<30;$j++){$column=$fixture['base']['tables'][0]['columns'][0];$column['id']="c-$i-$j";$column['name']="Column.$j";$table['columns'][]=$column;}$tables[]=$table;}
for($i=0;$i<10000;$i++){$source=intdiv($i,5);$target=($source+$i%5)%2000;$fk=$fixture['base']['foreignKeys'][0];$fk['id']="fk-$i";$fk['name']='FK.'.($i%5);$fk['tableId']="t-$source";$fk['columns']=["c-$source-0","c-$source-1"];$fk['target']=['tableId'=>"t-$target",'columns'=>["c-$target-1","c-$target-0"]];$fks[]=$fk;}
$value=$fixture['base'];$value['tables']=$tables;$value['foreignKeys']=$fks;$records=physicalGraphRecordScale(physicalGraphRecordFixture()['base'],2000);foreach(['indices','keys','checks'] as $field)$value[$field]=$records[$field];$generated=hrtime(true);$graph=Orm\PhysicalGraph::fromValue($value);$validated=hrtime(true);if($graph->value()!==$value)throw new RuntimeException('Lost stress graph fields');
$value['tables'][0]['columns'][0]['name']='changed';if($graph->value()['tables'][0]['columns'][0]['name']!=='Column.0')throw new RuntimeException('Aliased nested graph');
echo 'PASS physical_graph_retention tables=2000 columns=60000 foreignKeys=10000 indices=2000 keys=2000 checks=2000 generate='.(($generated-$scaleStarted)/1e6).' validate='.(($validated-$generated)/1e6).' elapsed='.((hrtime(true)-$scaleStarted)/1e6).' peakBytes='.memory_get_peak_usage(true).' memoryLimit='.ini_get('memory_limit')."\n";
$jsonStarted=hrtime(true);$text=$graph->toJson();unset($value,$graph,$tables,$fks,$records);echo 'RUN physical_json_retention bytes='.strlen($text).' currentBytes='.memory_get_usage(false).' allocatedBytes='.memory_get_usage(true)."\n";$parsed=Orm\PhysicalGraph::fromJson($text);echo 'RUN physical_json_emit currentBytes='.memory_get_usage(false).' allocatedBytes='.memory_get_usage(true)."\n";if($parsed->toJson()!==$text)throw new RuntimeException('Changed complete stress JSON');
echo 'PASS physical_json_retention bytes='.strlen($text).' elapsed='.((hrtime(true)-$jsonStarted)/1e6).' peakBytes='.memory_get_peak_usage(true).' memoryLimit='.ini_get('memory_limit')."\n";
$expectedHash=hash('sha256',$text);unset($text);$documentStarted=hrtime(true);echo "RUN physical_document_retention\n";
$source=Orm\PhysicalDocument::emit($parsed,"# Physical design\n\n","\nAfter\n");unset($parsed);
$document=Orm\PhysicalDocument::parse($source);
if(hash('sha256',$document->graph->toJson())!==$expectedHash||Orm\PhysicalDocument::emit($document->graph,$document->prefix,$document->suffix,$document->newline)!==$source)throw new RuntimeException('Changed complete stress document');
echo 'PASS physical_document_retention bytes='.strlen($source).' elapsed='.((hrtime(true)-$documentStarted)/1e6).' peakBytes='.memory_get_peak_usage(true).' memoryLimit='.ini_get('memory_limit')."\n";
unset($source,$document);
if(count($fixture['limits'])!==5)throw new RuntimeException('Missing limit vectors');
foreach($fixture['limits']as$limit){
 $tables=[];$comment=str_repeat('x',$limit['commentBytes']);
 for($i=0;$i<$limit['tables'];$i++){$table=$fixture['base']['tables'][0];$table['id']="t-$i";$table['identity']=[null,'main',"Table.$i",null];$table['columns']=[];for($j=0;$j<$limit['columns'];$j++){$column=$fixture['base']['tables'][0]['columns'][0];$column['id']="c-$i-$j";$column['name']="Column.$j";$column['comment']=$comment;$table['columns'][]=$column;}$tables[]=$table;}
 $value=$fixture['base'];$value['tables']=$tables;$value['foreignKeys']=array_fill(0,$limit['foreignKeys']??0,$fixture['base']['foreignKeys'][0]);
 try{Orm\PhysicalGraph::fromValue($value);throw new RuntimeException('Accepted graph limit');}catch(Orm\PhysicalGraphError$error){if($error->path()!==$limit['error'])throw new RuntimeException('Wrong limit path '.$limit['id'].': '.$error->path());}
 unset($value,$tables);echo 'PASS physical_graph_limit '.$limit['id']."\n";
}
if(hrtime(true)-$started>15e9)throw new RuntimeException('Graph deadline exceeded');echo 'PASS physical_graph 28 vectors '.((hrtime(true)-$started)/1e6)." ms\n";
