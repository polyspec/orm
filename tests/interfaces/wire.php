<?php
declare(strict_types=1);
require $argv[1] . '/clients/php/tests/autoload.php';
use Orm\Wire;
use Orm\OrmException;
$manifest=json_decode(file_get_contents($argv[1].'/contracts/interfaces.json'),true,512,JSON_THROW_ON_ERROR);
$records=array_column($manifest['records'],null,'id');
$fields=function(string $id)use(&$fields,$records):array{
    $r=$records[$id];return isset($r['extends'])? $fields($r['extends'])+$r['fields']:$r['fields'];
};
$sample=function(string $type,int $depth=0)use(&$sample,$records,$fields):mixed{
    if($type==='text'){return 'x';}if($type==='integer'){return 1;}if($type==='bool'){return true;}
    if(str_starts_with($type,'list<')){return $depth>1?[]:[$sample(substr($type,5,-1),$depth+1)];}
    if(str_starts_with($type,'map<')){return ['x'=>$sample(substr($type,4,-1),$depth+1)];}
    $r=$records[$type];$out=[];
    foreach($fields($type) as $k=>$t){
        if(($r['union']??false)&&$out!==[]){break;}
        if($depth>1&&in_array($k,$r['optional'],true)){continue;}
        $out[$k]=$sample($t,$depth+1);
    }
    if(($r['union']??false)&&$out===[]){$out['pred']=['column'=>'seq','op'=>'eq','p'=>0];}
    return $out;
};
$count=0;
$reject=function(string $id,array $bad)use(&$count):void{
    try{Wire::check($id,$bad);}catch(OrmException $e){if($e->code_==='IR_INVALID'){$count++;return;}throw $e;}
    throw new RuntimeException($id.': record mutation accepted');
};
foreach($records as $id=>$r){
    $valid=$sample($id);Wire::check($id,$valid);
    $bad=$valid;$bad['unexpected_controller']='x';$reject($id,$bad);
    foreach($fields($id)as $key=>$type){
        if(($r['union']??false)&&!array_key_exists($key,$valid)){continue;}
        $bad=$valid;$bad[$key]=($type==='text')?123:'invalid';$reject($id,$bad);
    }
}
echo 'php: ',count($records),' records, ',$count," field/shape mutations rejected\n";
