<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$started=hrtime(true);echo "RUN physical_column\n";
$fixture=json_decode(file_get_contents(dirname(__DIR__,3).'/contracts/fixtures/physical_columns.json'),true,512,JSON_THROW_ON_ERROR);
if(count($fixture['cases'])!==25)throw new RuntimeException('Missing vectors');
$seen=[];
foreach($fixture['cases'] as $case){
    if($case['id']===''||isset($seen[$case['id']]))throw new RuntimeException('Invalid case id');$seen[$case['id']]=true;
    $value=array_replace($fixture['base'],$case['changes']);
    try {$column=Orm\PhysicalColumn::fromValue($value);}
    catch(InvalidArgumentException $error){if(($case['error']??null)!==$error->getMessage())throw $error;continue;}
    if(isset($case['error'])||$column->value()!==$value)throw new RuntimeException('Changed physical fields');
    $copy=$column->value();$copy['default']['kind']='changed';$value['comment']='changed';
    if($column->value()['default']['kind']==='changed'||$column->value()['comment']==='changed')throw new RuntimeException('Aliased column');
}
$invalid=$fixture['base'];$invalid['typeSql']=str_repeat('x',4097);
try {Orm\PhysicalColumn::fromValue($invalid);throw new RuntimeException('Oversized type accepted');}
catch(InvalidArgumentException $error){if($error->getMessage()!=='SCHEMA_INVALID')throw $error;}
$referenced=$fixture['base'];$comment='original';$referenced['comment']=&$comment;
$column=Orm\PhysicalColumn::fromValue($referenced);$comment='changed';
if($column->value()['comment']!=='original')throw new RuntimeException('Referenced input changed immutable column');
foreach([
    ['typeSql'=>str_repeat('한',1366)],['typeSql'=>"\xff"],
    ['options'=>array_fill(0,64,['name'=>'option','value'=>str_repeat('x',1100)])],
    ['options'=>array_fill(0,65,['name'=>'option','value'=>''])]
] as $changes){
    try {Orm\PhysicalColumn::fromValue(array_replace($fixture['base'],$changes));throw new RuntimeException('Column budget/encoding accepted');}
    catch(InvalidArgumentException $error){if($error->getMessage()!=='SCHEMA_INVALID')throw $error;}
}
if(hrtime(true)-$started>3e9)throw new RuntimeException('Column deadline exceeded');
echo 'PASS physical_column 25 vectors '.((hrtime(true)-$started)/1e6)." ms\n";
