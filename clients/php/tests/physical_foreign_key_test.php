<?php
declare(strict_types=1);
require __DIR__.'/autoload.php';
$started=hrtime(true);echo "RUN physical_foreign_key\n";
$fixture=json_decode(file_get_contents(dirname(__DIR__,3).'/contracts/fixtures/physical_foreign_keys.json'),true,512,JSON_THROW_ON_ERROR);
if(count($fixture['cases'])!==26)throw new RuntimeException('Missing FK vectors');$seen=[];
foreach($fixture['cases']as$case){
 if($case['id']===''||isset($seen[$case['id']]))throw new RuntimeException('Invalid vector id');$seen[$case['id']]=true;
 $value=array_replace($fixture['base'],$case['changes']);
 try{$fk=Orm\PhysicalForeignKey::fromValue($value);}
 catch(InvalidArgumentException$error){if(($case['error']??null)!==$error->getMessage())throw$error;continue;}
 if(isset($case['error'])||$fk->value()!==$value)throw new RuntimeException('Changed FK fields/order');
 $copy=$fk->value();$copy['target']['tableId']='changed';$value['columns'][0]='changed';
 if($fk->value()['target']['tableId']==='changed'||$fk->value()['columns'][0]==='changed')throw new RuntimeException('Aliased FK');
}
$referenced=$fixture['base'];$comment='original';$referenced['comment']=&$comment;
$fk=Orm\PhysicalForeignKey::fromValue($referenced);$comment='changed';
if($fk->value()['comment']!=='original')throw new RuntimeException('Referenced FK input changed');
$bounded=$fixture['base'];$ids=array_map(static fn(int $index):string=>"column-$index",range(0,63));
$bounded['columns']=$ids;$bounded['target']['columns']=$ids;Orm\PhysicalForeignKey::fromValue($bounded);
$ids[]='column-64';$bounded['columns']=$ids;$bounded['target']['columns']=$ids;
try{Orm\PhysicalForeignKey::fromValue($bounded);throw new RuntimeException('Oversized FK accepted');}
catch(InvalidArgumentException$error){if($error->getMessage()!=='SCHEMA_INVALID')throw$error;}
$scaleStarted=hrtime(true);$retained=[];
for($index=0;$index<2000;$index++){
 $value=$fixture['base'];$value['id']="fk-$index";$value['name']="FK.$index";
 $retained[]=Orm\PhysicalForeignKey::fromValue($value);
}
foreach($retained as $index=>$fk){if($fk->value()['id']!=="fk-$index")throw new RuntimeException('Lost retained FK');}
echo 'PASS physical_fk_retention records='.count($retained).' elapsed='.((hrtime(true)-$scaleStarted)/1e6)." ms\n";
if(hrtime(true)-$started>3e9)throw new RuntimeException('FK deadline exceeded');
echo 'PASS physical_foreign_key 26 vectors '.((hrtime(true)-$started)/1e6)." ms\n";
