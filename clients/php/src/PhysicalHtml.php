<?php
declare(strict_types=1);
namespace Orm;

/** Internal explicit HTML ownership, without line/body copies. */
final class PhysicalHtml {
 private const BLOCK_TAGS=' address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul ';
 public static function blankStart(string $source,int $p,int $end):bool {
  if($end-$p<2||$source[$p]!=='<')return false;$p++;if($source[$p]==='/')$p++;$start=$p;
  while($p<$end&&(($source[$p]>='a'&&$source[$p]<='z')||($source[$p]>='A'&&$source[$p]<='Z')||($source[$p]>='0'&&$source[$p]<='9'))){if(++$p-$start>10)return false;}
  if($p===$start||!str_contains(self::BLOCK_TAGS,' '.strtolower(substr($source,$start,$p-$start)).' '))return false;
  return $p===$end||in_array($source[$p],[' ',"\t",'>'],true)||($source[$p]==='/'&&$p+1<$end&&$source[$p+1]==='>');
 }
 /** Null means ordinary text; -1 means a recognized but unfinished block. */
 public static function end(string $source,int $p,int $end):?int {
  if($p===$end||$source[$p]!=='<')return null;
  $starts=static fn(string $s):bool=>$end-$p>=strlen($s)&&substr_compare($source,$s,$p,strlen($s))===0;
  if($starts('<!--'))$delimiter='-->';
  elseif($starts('<?'))$delimiter='?>';
  elseif($starts('<![CDATA['))$delimiter=']]>';
  elseif($end-$p>2&&$source[$p+1]==='!'&&(($source[$p+2]>='A'&&$source[$p+2]<='Z')||($source[$p+2]>='a'&&$source[$p+2]<='z')))$delimiter='>';
  else {
   $raw=false;foreach(['pre','script','style','textarea']as$tag){$n=strlen($tag)+1;if($end-$p<$n||strtolower(substr($source,$p+1,strlen($tag)))!==$tag)continue;if($p+$n===$end||in_array($source[$p+$n],[' ',"\t",'>'],true)){$raw=true;break;}}
   if(!$raw)return null;
   $found=preg_match('~</(?:[pP][rR][eE]|[sS][cC][rR][iI][pP][tT]|[sS][tT][yY][lL][eE]|[tT][eE][xX][tT][aA][rR][eE][aA])>~',$source,$match,PREG_OFFSET_CAPTURE,$p);
   if($found===false)throw new PhysicalEnvelopeError(0);return $found===0?-1:$match[0][1]+strlen($match[0][0]);
  }
  $found=strpos($source,$delimiter,$p);return $found===false?-1:$found+strlen($delimiter);
 }
}
