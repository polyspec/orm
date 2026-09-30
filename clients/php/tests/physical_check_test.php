<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$started=hrtime(true);echo "RUN physical_check\n";
$fixture=json_decode(file_get_contents(dirname(__DIR__,3).'/contracts/fixtures/physical_checks.json'),true,512,JSON_THROW_ON_ERROR);
if(count($fixture['cases'])!==24)throw new RuntimeException('Missing CHECK vectors');$seen=[];
foreach($fixture['cases'] as $case){
 if($case['id']===''||isset($seen[$case['id']]))throw new RuntimeException('Invalid case ID');$seen[$case['id']]=true;
 $value=array_replace($fixture['base'],$case['changes']);
 try{$record=Orm\PhysicalCheck::fromValue($value);}
 catch(InvalidArgumentException $error){if(($case['error']??null)!==$error->getMessage())throw $error;continue;}
 if(isset($case['error'])||$record->value()!==$value)throw new RuntimeException('Changed CHECK record');
 if(count($value['options'])>0){$value['options'][0]['value']='changed';$copy=$record->value();$copy['options'][0]['value']='changed';if($record->value()['options'][0]['value']==='changed')throw new RuntimeException('Aliased CHECK');}
}
if(count($fixture['bounds'])!==17)throw new RuntimeException('Missing bounds');$seen=[];
foreach($fixture['bounds'] as $case){
 if($case['id']===''||isset($seen[$case['id']]))throw new RuntimeException('Invalid bounds ID');$seen[$case['id']]=true;
 $value=$fixture['base'];
 if(isset($case['field']))$value[$case['field']]=str_repeat($case['unit'],$case['count']);
 if(isset($case['options']))$value['options']=array_fill(0,$case['options'],['name'=>'x','value'=>str_repeat('x',$case['size'])]);
 if(isset($case['drop']))unset($value[$case['drop']]);
 try{$record=Orm\PhysicalCheck::fromValue($value);}
 catch(InvalidArgumentException $error){if(($case['error']??null)!==$error->getMessage())throw $error;continue;}
 if(isset($case['error'])||$record->value()!==$value)throw new RuntimeException('Changed bounded record');
}
$value=$fixture['base'];$value['expressionSql']="\xff";
try{Orm\PhysicalCheck::fromValue($value);throw new RuntimeException('Invalid UTF-8 accepted');}
catch(InvalidArgumentException $error){if($error->getMessage()!=='SCHEMA_INVALID')throw $error;}
$value=$fixture['base'];$expression='original';$option='original';$value['expressionSql']=&$expression;$value['options'][0]['value']=&$option;
$record=Orm\PhysicalCheck::fromValue($value);$expression='changed';$option='changed';
if($record->value()['expressionSql']!=='original'||$record->value()['options'][0]['value']!=='original')throw new RuntimeException('Referenced CHECK input');
if(hrtime(true)-$started>3e9)throw new RuntimeException('CHECK deadline exceeded');
echo 'PASS physical_check 24 vectors 17 bounds '.((hrtime(true)-$started)/1e6)." ms\n";
