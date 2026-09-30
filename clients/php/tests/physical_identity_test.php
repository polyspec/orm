<?php
declare(strict_types=1);
require __DIR__ . '/autoload.php';

$started=hrtime(true);
echo "RUN physical_identity\n";
$cases=json_decode(file_get_contents(dirname(__DIR__,3).'/contracts/fixtures/physical_identities.json'),true,512,JSON_THROW_ON_ERROR);
if(count($cases)!==10)throw new RuntimeException('Missing identity vectors');
$seen=[];
foreach($cases as $case){
    if($case['id']===''||isset($seen[$case['id']]))throw new RuntimeException('Duplicate or empty vector');
    $seen[$case['id']]=true;
    try {$identity=new Orm\PhysicalIdentity(...$case['parts']);}
    catch(InvalidArgumentException $error){
        if(($case['error']??null)!==$error->getMessage())throw new RuntimeException('Unexpected identity rejection');
        continue;
    }
    if(isset($case['error'])||$identity->key()!==$case['key']||$identity->parts()!==$case['parts'])throw new RuntimeException('Identity mismatch');
    $parts=$identity->parts();$parts[2]='changed';
    if($identity->key()!==$case['key']||$identity->parts()[2]==='changed')throw new RuntimeException('Aliased identity');
}
foreach([str_repeat('x',1025),str_repeat('한',342),"\xff"] as $name){
    try {new Orm\PhysicalIdentity(null,null,$name,null);throw new RuntimeException('Invalid identity accepted');}
    catch(InvalidArgumentException $error){if($error->getMessage()!=='SCHEMA_INVALID')throw $error;}
}
new Orm\PhysicalIdentity(null,null,str_repeat('x',1024),null);
if(hrtime(true)-$started>3e9)throw new RuntimeException('Identity test deadline exceeded');
echo 'PASS physical_identity '.count($cases).' vectors '.((hrtime(true)-$started)/1e6)." ms\n";
