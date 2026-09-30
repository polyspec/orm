<?php
declare(strict_types=1);
namespace Orm;

/** Source ranges only; no schema or diagram validation. */
final class PhysicalEnvelope {
 /** @return array{start:int,body:int,close:int,end:int} */
 public static function locate(string $source):array {
  $size=strlen($source);
  if($size>67108864||preg_match('//u',$source)!==1||str_starts_with($source,"\xef\xbb\xbf")||substr_count($source,"\n")+1>200000)throw new PhysicalEnvelopeError(0);
  for($i=0;($i=strpos($source,"\r",$i))!==false;$i++){if($i+1===$size||$source[$i+1]!=="\n")throw new PhysicalEnvelopeError(0);}
  $active='';$run=0;$opened=0;$blocks=0;$found=false;$owned=false;$result=[];
  $htmlEnd=0;
  $htmlBlank=false;
  for($start=0,$line=1;$start<$size;$line++){
   $next=strpos($source,"\n",$start);$end=$next===false?$size:$next+1;$contentEnd=$end;
   if($contentEnd>$start&&$source[$contentEnd-1]==="\n")$contentEnd--;if($contentEnd>$start&&$source[$contentEnd-1]==="\r")$contentEnd--;
   $p=$start;while($p<$contentEnd&&$p-$start<4&&$source[$p]===' ')$p++;
   if($htmlEnd!==0){if($htmlEnd<=$contentEnd)$htmlEnd=0;$start=$end;continue;}
   if($htmlBlank){if(strspn($source," \t",$start,$contentEnd-$start)===$contentEnd-$start)$htmlBlank=false;$start=$end;continue;}
   if($active===''&&$p-$start<=3){$close=PhysicalHtml::end($source,$p,$contentEnd);if($close!==null){if($close<0)throw new PhysicalEnvelopeError($line);if($close>$contentEnd)$htmlEnd=$close;$start=$end;continue;}if(PhysicalHtml::blankStart($source,$p,$contentEnd)){$htmlBlank=true;$start=$end;continue;}}
   if($p-$start<=3&&$p<$contentEnd&&($source[$p]==='`'||$source[$p]==='~')){
    $ch=$source[$p];$q=$p;while($q<$contentEnd&&$source[$q]===$ch)$q++;$length=$q-$p;
    $left=$q;$right=$contentEnd;while($left<$right&&($source[$left]===' '||$source[$left]==="\t"))$left++;while($right>$left&&($source[$right-1]===' '||$source[$right-1]==="\t"))$right--;
    if($active!==''){if($ch===$active&&$length>=$run&&$left===$right){if($owned){$result['close']=$start;$result['end']=$end;}$active='';$owned=false;}}
    elseif($length>=3&&($ch!=='`'||strcspn($source,'`',$q,$contentEnd-$q)===$contentEnd-$q)){
     if(++$blocks>4096)throw new PhysicalEnvelopeError(0);
     $owned=$p===$start&&$right-$left>=21&&substr_compare($source,'mermaid orm-physical-',$left,21)===0;
     if($owned){if($right-$left!==23||substr_compare($source,'mermaid orm-physical-v1',$left,23)!==0||$found)throw new PhysicalEnvelopeError($line);$found=true;$result=['start'=>$start,'body'=>$end];}
     $active=$ch;$run=$length;$opened=$line;
    }
   }
   $start=$end;
  }
  if($active!=='')throw new PhysicalEnvelopeError($opened);if(!$found)throw new PhysicalEnvelopeError(0);return $result;
 }
}
