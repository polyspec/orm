<?php
declare(strict_types=1);
namespace Orm;

/** Experimental document grammar; not import or execution authority. */
final readonly class PhysicalDocument {
 private function __construct(public PhysicalGraph $graph,private string $source,private array $ranges,public string $newline,public string $diagram){}
 /** Retain the input through PHP copy-on-write, without duplicating prose. */
 public function source():string{return $this->source;}
 public function prefix():string{return substr($this->source,0,$this->ranges['start']);}
 public function suffix():string{return substr($this->source,$this->ranges['end']);}
 public static function parse(string $source):self {
  try{$r=PhysicalEnvelope::locate($source);}catch(PhysicalEnvelopeError $e){throw new PhysicalDocumentError($e->line());}
  $newline=substr($source,$r['body']-2,2)==="\r\n"?"\r\n":"\n";
  $line=substr_count($source,"\n",0,$r['body'])+1;$position=$r['body'];
  $next=static function()use(&$position,$source,$r):?string {
   if($position>=$r['close'])return null;
   $end=strpos($source,"\n",$position);if($end===false||$end>$r['close'])$end=$r['close'];
   $stop=$end;if($stop>$position&&$source[$stop-1]==="\r")$stop--;
   $out=substr($source,$position,$stop-$position);$position=$end+1;return $out;
  };
  $expect=static function(string $expected)use($next,&$line):void {if($next()!==$expected)throw new PhysicalDocumentError($line);$line++;};
  $expect('erDiagram');$expect('%% orm:physical-json 1');
  $end=strpos($source,"\n",$position);if($end===false||$end>$r['close'])$end=$r['close'];$stop=$end;if($stop>$position&&$source[$stop-1]==="\r")$stop--;
  if($position>=$r['close']||substr($source,$position,3)!=='%% ')throw new PhysicalDocumentError($line);
  try{$graph=PhysicalGraph::fromJson(substr($source,$position+3,$stop-$position-3));}catch(PhysicalGraphError $e){throw new PhysicalDocumentError($line,$e->path());}catch(\InvalidArgumentException $e){if($e->getMessage()!=='SCHEMA_INVALID')throw $e;throw new PhysicalDocumentError($line);}
  $position=$end+1;$line++;$expect('%% orm:physical-json-end');$diagram="erDiagram\n";
  foreach(PhysicalProjection::lines($graph)as$expected){$expect($expected);$diagram.=$expected."\n";}
  if($next()!==null)throw new PhysicalDocumentError($line);
  return new self($graph,$source,$r,$newline,$diagram);
 }
 public static function emit(PhysicalGraph $graph,string $prefix='',string $suffix='',string $newline="\n"):string {
  if(!in_array($newline,["\n","\r\n"],true)||$prefix!==''&&!str_ends_with($prefix,"\n"))throw new PhysicalDocumentError(0);
  $out=$prefix.'```mermaid orm-physical-v1'.$newline.'erDiagram'.$newline.'%% orm:physical-json 1'.$newline.'%% '.$graph->toJson().$newline.'%% orm:physical-json-end'.$newline;
  foreach(PhysicalProjection::lines($graph)as$line)$out.=$line.$newline;
  $out.='```'.$newline.$suffix;
  try{$r=PhysicalEnvelope::locate($out);}catch(PhysicalEnvelopeError $e){throw new PhysicalDocumentError($e->line());}
  if($r['start']!==strlen($prefix)||substr($out,$r['end'])!==$suffix)throw new PhysicalDocumentError(0);
  return $out;
 }
}
