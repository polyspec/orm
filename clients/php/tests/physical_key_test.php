<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$started=hrtime(true);echo "RUN physical_key\n";
$fixture=json_decode(file_get_contents(dirname(__DIR__,3).'/contracts/fixtures/physical_keys.json'),true,512,JSON_THROW_ON_ERROR);
if(count($fixture['cases'])!==35||count($fixture['bounds'])!==14)throw new RuntimeException('Missing key vectors');$seen=[];
foreach(array_merge($fixture['cases'],$fixture['bounds']) as $case){
 $caseStarted=hrtime(true);$id=$case['id'];if($id===''||isset($seen[$id]))throw new RuntimeException('Invalid case ID');$seen[$id]=true;echo "RUN $id\n";
 $value=array_replace($fixture['base'],$case['changes']??[]);
 if(isset($case['drop']))unset($value[$case['drop']]);
 if(isset($case['field']))$value[$case['field']]=str_repeat($case['unit']??'x',$case['count']);
 if(isset($case['columns']))$value['columns']=array_map(static fn(int $i):string=>"column-$i",range(0,$case['columns']-1));
 if(isset($case['options']))$value['options']=array_fill(0,$case['options'],['name'=>'x','value'=>str_repeat('x',$case['size'])]);
 try{$key=Orm\PhysicalKey::fromValue($value);}
 catch(InvalidArgumentException $error){if(($case['error']??null)!==$error->getMessage())throw $error;if(hrtime(true)-$caseStarted>1e9)throw new RuntimeException('Case deadline exceeded');echo "PASS $id ".((hrtime(true)-$caseStarted)/1e6)." ms\n";continue;}
 if(isset($case['error'])||$key->value()!==$value)throw new RuntimeException("Changed key $id");
 $value['columns'][0]='changed';$copy=$key->value();$copy['columns'][0]='changed';if($key->value()['columns'][0]==='changed')throw new RuntimeException('Aliased key columns');
 if(count($value['options'])>0){$value['options'][0]['value']='changed';$copy['options'][0]['value']='changed';if($key->value()['options'][0]['value']==='changed')throw new RuntimeException('Aliased key options');}
 if(hrtime(true)-$caseStarted>1e9)throw new RuntimeException('Case deadline exceeded');echo "PASS $id ".((hrtime(true)-$caseStarted)/1e6)." ms\n";
}
$value=$fixture['base'];$column='original';$option='original';$value['columns'][0]=&$column;$value['options'][0]['value']=&$option;
$key=Orm\PhysicalKey::fromValue($value);$column='changed';$option='changed';if($key->value()['columns'][0]!=='original'||$key->value()['options'][0]['value']!=='original')throw new RuntimeException('Referenced key input changed');
foreach(['name','indexId','comment'] as $field){$value=$fixture['base'];$value[$field]="\xff";try{Orm\PhysicalKey::fromValue($value);throw new RuntimeException('Invalid UTF-8 accepted');}catch(InvalidArgumentException $error){if($error->getMessage()!=='SCHEMA_INVALID')throw $error;}}
if(hrtime(true)-$started>3e9)throw new RuntimeException('Key deadline exceeded');echo 'PASS physical_key 35 vectors 14 bounds '.((hrtime(true)-$started)/1e6)." ms\n";
