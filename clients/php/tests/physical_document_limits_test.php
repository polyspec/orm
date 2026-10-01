<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
require __DIR__.'/process_cpu.php';
$f=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_graph_json.json'),true,512,JSON_THROW_ON_ERROR);
$block=Orm\PhysicalDocument::emit(Orm\PhysicalGraph::fromValue($f['empty']));
$limits=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_envelope.json'),true,512,JSON_THROW_ON_ERROR)['limits'];
$check=static function(string $source,bool $accepted,string $id)use($f):void{
 echo 'RUN '.$id.' memoryLimit='.ini_get('memory_limit')."\n";$started=hrtime(true);$startedCpu=processCpuNs();
 try{$document=Orm\PhysicalDocument::parse($source);if(!$accepted)throw new RuntimeException('Accepted excess');if($document->graph->value()!==$f['empty']||$document->source()!==$source)throw new RuntimeException('Changed document');}
 catch(Orm\PhysicalDocumentError $e){if($accepted||$e->line()!==0||$e->path()!==''||$e->getMessage()!=='SCHEMA_INVALID')throw new RuntimeException('Wrong diagnostic');}
 $cpu=processCpuNs()-$startedCpu;if($cpu>=15e9)throw new RuntimeException('Deadline exceeded: process CPU '.($cpu/1e6).' ms');
 echo 'PASS '.$id.' elapsedMs='.((hrtime(true)-$started)/1e6).' cpuMs='.($cpu/1e6).' peakBytes='.memory_get_peak_usage(true)."\n";
};
foreach(['bytes','lines','blocks']as$kind)foreach([0,1]as$extra){
 $n=$limits[$kind]+$extra;
 if($kind==='bytes'){
  // Build one input allocation rather than manufacturing a generator copy failure.
  $source=str_repeat('x',$n);for($i=0,$size=strlen($block);$i<$size;$i++)$source[$i]=$block[$i];
 }elseif($kind==='lines')$source=str_repeat("\n",$n-substr_count($block,"\n")-1).$block;
 else $source=str_repeat("```text\n```\n",$n-1).$block;
 $check($source,$extra===0,$kind.'-'.$extra);unset($source);
}
