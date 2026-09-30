<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$started=hrtime(true);echo "RUN physical_index\n";
$fixture=json_decode(file_get_contents(dirname(__DIR__,3).'/contracts/fixtures/physical_indices.json'),true,512,JSON_THROW_ON_ERROR);
if(count($fixture['cases'])!==46||count($fixture['bounds'])!==20)throw new RuntimeException('Missing index vectors');
$seen=[];
foreach(array_merge($fixture['cases'],$fixture['bounds']) as $case){
 $caseStarted=hrtime(true);$id=$case['id'];if($id===''||isset($seen[$id]))throw new RuntimeException('Invalid case ID');$seen[$id]=true;echo "RUN $id\n";
 $value=array_replace($fixture['base'],$case['changes']??[]);
 if(isset($case['termChanges']))$value['terms'][0]=array_replace($value['terms'][0],$case['termChanges']);
 if(isset($case['drop']))unset($value[$case['drop']]);
 if(isset($case['field']))$value[$case['field']]=str_repeat($case['unit']??'x',$case['count']);
 if(isset($case['termField']))$value['terms'][0][$case['termField']]=str_repeat($case['unit']??'x',$case['count']);
 if(isset($case['expression']))$value['terms'][0]['source']=['kind'=>'expression','sql'=>str_repeat('x',$case['expression'])];
 if(isset($case['terms']))$value['terms']=array_fill(0,$case['terms'],$value['terms'][0]);
 if(isset($case['include']))$value['include']=array_map(static fn(int $i):string=>"included-$i",range(0,$case['include']-1));
 if(isset($case['options']))$value['options']=array_fill(0,$case['options'],['name'=>'x','value'=>str_repeat('x',$case['size'])]);
 try{$index=Orm\PhysicalIndex::fromValue($value);}
 catch(InvalidArgumentException $error){if(($case['error']??null)!==$error->getMessage())throw $error;echo "PASS $id ".((hrtime(true)-$caseStarted)/1e6)." ms\n";continue;}
 if(isset($case['error'])||$index->value()!==$value)throw new RuntimeException("Changed index $id");
 $value['terms'][0]['source']['kind']='changed';$copy=$index->value();$copy['terms'][0]['source']['kind']='changed';
 if($index->value()['terms'][0]['source']['kind']==='changed')throw new RuntimeException('Aliased nested source');
 if(count($copy['include'])>0){$copy['include'][0]='changed';if($index->value()['include'][0]==='changed')throw new RuntimeException('Aliased included columns');}
 echo "PASS $id ".((hrtime(true)-$caseStarted)/1e6)." ms\n";
}
$value=$fixture['base'];$column='original';$included='original';$option='original';$value['terms'][0]['source']['columnId']=&$column;$value['include'][0]=&$included;$value['options'][0]['value']=&$option;
$index=Orm\PhysicalIndex::fromValue($value);$column='changed';$included='changed';$option='changed';
$snapshot=$index->value();if($snapshot['terms'][0]['source']['columnId']!=='original'||$snapshot['include'][0]!=='original'||$snapshot['options'][0]['value']!=='original')throw new RuntimeException('Referenced input changed');
foreach(['name','methodSql','predicateSql','comment'] as $field){$value=$fixture['base'];$value[$field]="\xff";try{Orm\PhysicalIndex::fromValue($value);throw new RuntimeException('Invalid UTF-8 accepted');}catch(InvalidArgumentException $error){if($error->getMessage()!=='SCHEMA_INVALID')throw $error;}}
foreach([NAN,INF,-INF] as $prefix){$value=$fixture['base'];$value['terms'][0]['prefixLength']=$prefix;try{Orm\PhysicalIndex::fromValue($value);throw new RuntimeException('Nonfinite prefix accepted');}catch(InvalidArgumentException $error){if($error->getMessage()!=='SCHEMA_INVALID')throw $error;}}
if(hrtime(true)-$started>3e9)throw new RuntimeException('Index deadline exceeded');echo 'PASS physical_index 46 vectors 20 bounds '.((hrtime(true)-$started)/1e6)." ms\n";
