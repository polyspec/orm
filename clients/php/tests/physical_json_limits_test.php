<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
foreach(['byte-limit','byte-excess','depth-limit','depth-excess','node-limit','node-excess']as$id){
 $start=hrtime(true);echo "RUN $id\n";$ok=str_ends_with($id,'limit');
 $text=match($id){'byte-limit'=>str_repeat(' ',33554431).'0','byte-excess'=>str_repeat(' ',33554432).'0','depth-limit'=>str_repeat('[',16).'0'.str_repeat(']',16),'depth-excess'=>str_repeat('[',17).'0'.str_repeat(']',17),'node-limit'=>'['.str_repeat('0,',2999998).'0]','node-excess'=>'['.str_repeat('0,',2999999).'0]'};
 try{$value=Orm\PhysicalJson::decode($text);if(!$ok)throw new RuntimeException('Accepted excess');unset($value);}catch(Orm\PhysicalGraphError$e){if($ok||$e->getMessage()!=='SCHEMA_INVALID'||$e->path()!=='')throw new RuntimeException('Wrong limit result');}
 unset($text);if(hrtime(true)-$start>15e9)throw new RuntimeException('Deadline exceeded');echo "PASS $id ".((hrtime(true)-$start)/1e6)." ms\n";
}
