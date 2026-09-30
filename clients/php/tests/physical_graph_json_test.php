<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$start=hrtime(true);echo "RUN physical_graph_json\n";
$fixture=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_graph_json.json'),true,512,JSON_THROW_ON_ERROR);
if(count($fixture['cases'])!==30)throw new RuntimeException('Missing cases');
$fail=static function(string $text,string $path):void{try{Orm\PhysicalGraph::fromJson($text);throw new RuntimeException('Expected rejection');}catch(Orm\PhysicalGraphError $e){if($e->getMessage()!=='SCHEMA_INVALID'||$e->path()!==$path)throw new RuntimeException('Wrong error');}};
foreach($fixture['cases']as$c){echo 'RUN '.$c['id']."\n";if($c['ok']??false){if(Orm\PhysicalGraph::fromJson($c['text'])->value()!==$fixture['empty'])throw new RuntimeException('Changed empty graph');}else $fail($c['text'],$c['path']);echo 'PASS '.$c['id']."\n";}
foreach($fixture['versions']as$i=>$v){$text=str_replace('"version":1','"version":'.$v,json_encode($fixture['empty'],JSON_THROW_ON_ERROR));if($i<4){if(Orm\PhysicalGraph::fromJson($text)->value()!==$fixture['empty'])throw new RuntimeException('Changed version');}else $fail($text,'');}
$records=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_graph_records.json'),true,512,JSON_THROW_ON_ERROR)['base'];$records['tables'][0]['comment']='</script> <!-- --> " \\ 😺 �';
$g=Orm\PhysicalGraph::fromJson(json_encode($records,JSON_THROW_ON_ERROR));$out=$g->toJson();$again=Orm\PhysicalGraph::fromJson($out);if($again->value()!==$records||$again->toJson()!==$out)throw new RuntimeException('Changed roundtrip');
$copy=$again->value();$copy['tables'][0]['columns'][0]['default']['kind']='changed';if($again->value()['tables'][0]['columns'][0]['default']['kind']!=='absent'||$copy['tables'][0]['columns'][1]['default']['kind']!=='absent')throw new RuntimeException('Shared object aliases');
foreach([str_repeat(' ',$fixture['bounds']['bytes']+1),str_repeat('[',17).str_repeat(']',17),'['.str_repeat('0,',$fixture['bounds']['nodes']).'0]',"\xff"]as$text)$fail($text,'');
if(hrtime(true)-$start>15e9)throw new RuntimeException('Deadline exceeded');echo 'PASS physical_graph_json '.((hrtime(true)-$start)/1e6)." ms\n";
