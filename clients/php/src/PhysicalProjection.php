<?php
declare(strict_types=1);
namespace Orm;

/** Display only; exact values and SQL semantics stay in metadata. */
final class PhysicalProjection {
 public static function display(string $text):string {
  return preg_replace_callback('/[\x00-\x1f\x7f"\\\\<>&#`%\[\]{}]|␛/u',static fn($m)=>'␛'.($m[0]==='␛'?'241b':sprintf('%04x',ord($m[0]))),$text);
 }
 public static function restore(string $text):string {
  return preg_replace_callback('/␛([0-9a-f]{4})/',static fn($m)=>$m[1]==='241b'?'␛':chr(hexdec($m[1])),$text);
 }
 /** @return \Generator<string> */
 public static function lines(PhysicalGraph $graph):\Generator {
  yield '%% Multiplicity and identifying status are unverified display conventions.';
  $v=$graph->value();$quote=self::display('"');
  foreach($v['tables']as$t){
   $parts=[];foreach(array_slice($t['identity'],0,3)as$p)$parts[]=$p===null?'null':$quote.self::display($p).$quote;
   $label=self::display('[').implode(',',$parts).self::display(']');
   yield '    T_'.bin2hex($t['id']).'["'.$label.'"] {';
   foreach($t['columns']as$c)yield '        physical C_'.bin2hex($c['id']).' "'.self::display($c['name']).' | '.self::display($c['typeSql']).'"';
   yield '    }';
  }
  foreach($v['foreignKeys']as$f){$pairs=[];foreach($f['columns']as$i=>$c)$pairs[]=$c.'->'.$f['target']['columns'][$i];
   yield '%% FK '.$f['id'].' '.implode(',',$pairs);
   yield '    T_'.bin2hex($f['tableId']).' }o..o{ T_'.bin2hex($f['target']['tableId']).' : "unverified FK '.$f['id'].'"';
  }
 }
}
