<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$start=hrtime(true);echo "RUN physical-document\n";
$f=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_document.json'),true,512,JSON_THROW_ON_ERROR);
$v=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_graph_records.json'),true,512,JSON_THROW_ON_ERROR)['base'];
$v['tables'][0]['identity'][2]=$f['tableName'];$v['tables'][0]['columns'][0]['name']=$f['columnName'];$v['tables'][0]['columns'][0]['typeSql']=$f['typeSql'];$v['tables'][0]['columns'][0]['comment']=$f['columnComment'];
$fk=$v['foreignKeys'][0];$fk['id']='fk-2';$fk['name']='FK.Second';$v['foreignKeys'][]=$fk;
$g=Orm\PhysicalGraph::fromValue($v);
$text=Orm\PhysicalDocument::emit($g,$f['prefix'],$f['suffix'],$f['newline']);
$d=Orm\PhysicalDocument::parse($text);
if($d->graph->value()!==$v||$d->prefix()!==$f['prefix']||$d->suffix()!==$f['suffix']||$d->source()!==$text||Orm\PhysicalDocument::emit($d->graph,$d->prefix(),$d->suffix(),$d->newline)!==$text)throw new RuntimeException('Changed document');
if(substr_count($d->diagram,' : ')!==2)throw new RuntimeException('Lost parallel FK');
foreach($f['displayStrings']as$s)if(Orm\PhysicalProjection::restore(Orm\PhysicalProjection::display($s))!==$s)throw new RuntimeException('Display changed');
if(count($f['mutations'])!==7)throw new RuntimeException('Missing document vectors');
foreach($f['mutations']as$c){echo 'RUN '.$c['id']."\n";$at=strpos($text,$c['from']);if($at===false)throw new RuntimeException('Missing mutation target');$bad=substr_replace($text,$c['to'],$at,strlen($c['from']));try{Orm\PhysicalDocument::parse($bad);throw new RuntimeException('Accepted contradiction');}catch(Orm\PhysicalDocumentError $e){if($e->line()!==$c['line']||$e->path()!==($c['path']??'')||$e->getMessage()!=='SCHEMA_INVALID')throw new RuntimeException('Wrong diagnostic');}echo 'PASS '.$c['id']."\n";}
try{Orm\PhysicalDocument::parse($text.$text);throw new RuntimeException('Duplicate accepted');}catch(Orm\PhysicalDocumentError $e){}
foreach(['No newline',"<!--\n"]as$p)try{Orm\PhysicalDocument::emit($g,$p);throw new RuntimeException('Invalid prose accepted');}catch(Orm\PhysicalDocumentError $e){}
foreach(['tables','foreignKeys','indices','keys','checks']as$k)$v[$k]=[];
if(Orm\PhysicalDocument::parse(Orm\PhysicalDocument::emit(Orm\PhysicalGraph::fromValue($v)))->graph->value()!==$v)throw new RuntimeException('Empty graph changed');
if(hrtime(true)-$start>15e9)throw new RuntimeException('Deadline exceeded');echo 'PASS physical-document '.((hrtime(true)-$start)/1e6)." ms\n";
