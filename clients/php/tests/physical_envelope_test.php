<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$f=json_decode(file_get_contents(__DIR__.'/../../../contracts/fixtures/physical_envelope.json'),true,512,JSON_THROW_ON_ERROR);
if(count($f['cases'])!==21)throw new RuntimeException('Missing cases');
$check=function(array $c):void {
 $start=hrtime(true);echo 'RUN '.$c['id']."\n";
 try {
  $r=Orm\PhysicalEnvelope::locate($c['text']);
  if($c['reject']??false)throw new RuntimeException('Accepted invalid source');
  if(!isset($c['bounds'])&&(substr($c['text'],0,$r['start'])!==$c['before']||substr($c['text'],$r['body'],$r['close']-$r['body'])!==$c['body']||substr($c['text'],$r['end'])!==$c['after']))throw new RuntimeException('Source changed');
 }catch(Orm\PhysicalEnvelopeError $e){if(!($c['reject']??false)||$e->getMessage()!=='SCHEMA_INVALID'||$e->line()!==$c['line'])throw new RuntimeException('Wrong diagnostic');}
 if(hrtime(true)-$start>15e9)throw new RuntimeException('Deadline exceeded');echo 'PASS '.$c['id'].' '.((hrtime(true)-$start)/1e6)." ms\n";
};
foreach($f['cases']as$c)$check($c);
$block="```mermaid orm-physical-v1\n```\n";
foreach(['bytes','lines','blocks']as$kind)foreach([0,1]as$extra){$n=$f['limits'][$kind]+$extra;$text=match($kind){'bytes'=>str_repeat('x',$n-strlen($block)-1)."\n".$block,'lines'=>str_repeat("\n",$n-3).$block,'blocks'=>str_repeat("```text\n```\n",$n-1).$block};$check(['id'=>$kind.'-'.$extra,'text'=>$text,'bounds'=>true,'reject'=>$extra===1,'line'=>0]);unset($text);}
$check(['id'=>'invalid-utf8','text'=>"\xff",'reject'=>true,'line'=>0]);
echo 'Peak allocated bytes '.memory_get_peak_usage(true)."\n";
