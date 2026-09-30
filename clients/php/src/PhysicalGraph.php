<?php
declare(strict_types=1);
namespace Orm;

/** Detached physical nodes and FK membership, not full schema or SQL authority. */
final readonly class PhysicalGraph
{
    private function __construct(private array $snapshot){}
    private static function at(string $path,callable $run):mixed
    {
        try{return $run();}catch(\InvalidArgumentException $error){if($error instanceof PhysicalGraphError)throw $error;if($error->getMessage()!=='SCHEMA_INVALID')throw $error;throw new PhysicalGraphError($path);}
    }
    private static function items(mixed $value,int $max,string $path,int $min=0):array
    {
        if(!is_array($value)||!array_is_list($value)||count($value)<$min||count($value)>$max)throw new PhysicalGraphError($path);return $value;
    }
    /** Only newly detached, validated, bounded-depth records are accepted. */
    private static function bytes(mixed $value):int
    {
        if(is_string($value))return strlen($value);if(!is_array($value))return 0;$total=0;foreach($value as $child)$total+=self::bytes($child);return $total;
    }
    public static function fromValue(mixed $value):self
    {
        $root=self::at('',fn()=>PhysicalRecord::shape($value,['version','dialect','dialectVersion','tables','foreignKeys']));
        if($root['version']!==1&&$root['version']!==1.0)throw new PhysicalGraphError('/version');
        if(!in_array($root['dialect'],['mysql','postgres','sqlite'],true))throw new PhysicalGraphError('/dialect');
        $dialectVersion=self::at('/dialectVersion',fn()=>(new PhysicalRecord())->text($root['dialectVersion'],1,128));
        $inputTables=self::items($root['tables'],4096,'/tables');$inputFKs=self::items($root['foreignKeys'],20000,'/foreignKeys');
        $ids=[];$identities=[];$tableIDs=[];$owners=[];$tables=[];$fks=[];$columnCount=0;$bytes=strlen($root['dialect'].$dialectVersion);
        $reserve=static function(string $id,string $path)use(&$ids):void{if(isset($ids[$id]))throw new PhysicalGraphError($path);$ids[$id]=true;};
        $budget=static function(array $record,string $path)use(&$bytes):void{$bytes+=self::bytes($record);if($bytes>16*1024*1024)throw new PhysicalGraphError($path);};
        foreach($inputTables as $index=>$input){
            $path="/tables/$index";$record=self::at($path,fn()=>PhysicalRecord::shape($input,['id','identity','columns','comment','options']));$v=new PhysicalRecord();
            $id=self::at("$path/id",fn()=>$v->id($record['id']));$reserve($id,"$path/id");
            $parts=$record['identity'];if(!is_array($parts)||!array_is_list($parts)||count($parts)!==4||$parts[3]!==null||!is_string($parts[2]))throw new PhysicalGraphError("$path/identity");
            foreach($parts as $part)if($part!==null&&!is_string($part))throw new PhysicalGraphError("$path/identity");
            $identity=self::at("$path/identity",fn()=>new PhysicalIdentity($parts[0],$parts[1],$parts[2],null));
            if(isset($identities[$identity->key()]))throw new PhysicalGraphError("$path/identity");$identities[$identity->key()]=true;$tableIDs[$id]=true;
            $inputs=self::items($record['columns'],4096,"$path/columns",1);$columnCount+=count($inputs);if($columnCount>120000)throw new PhysicalGraphError("$path/columns");$columns=[];$names=[];
            foreach($inputs as $j=>$input){$columnPath="$path/columns/$j";$column=self::at($columnPath,fn()=>PhysicalColumn::fromValue($input))->value();$reserve($column['id'],"$columnPath/id");if(isset($names[$column['name']]))throw new PhysicalGraphError("$columnPath/name");$names[$column['name']]=true;$owners[$column['id']]=$id;$budget($column,$columnPath);$columns[]=$column;}
            $comment=self::at("$path/comment",fn()=>$v->text($record['comment'],0,8192));self::at("$path/options",fn()=>$v->options($record['options']));
            $metadata=['id'=>$id,'identity'=>$identity->parts(),'comment'=>$comment,'options'=>PhysicalRecord::detached($record['options'])];if(self::bytes($metadata)>65536)throw new PhysicalGraphError($path);$budget($metadata,$path);$metadata['columns']=$columns;
            $owned=[];foreach(array_keys($record)as$key)$owned[$key]=$metadata[$key];$tables[]=$owned;
        }
        $names=[];
        foreach($inputFKs as $index=>$input){$path="/foreignKeys/$index";$fk=self::at($path,fn()=>PhysicalForeignKey::fromValue($input))->value();$reserve($fk['id'],"$path/id");
            if(!isset($tableIDs[$fk['tableId']]))throw new PhysicalGraphError("$path/tableId");if(!isset($tableIDs[$fk['target']['tableId']]))throw new PhysicalGraphError("$path/target/tableId");
            foreach($fk['columns']as$j=>$column){if(($owners[$column]??null)!==$fk['tableId'])throw new PhysicalGraphError("$path/columns/$j");if(($owners[$fk['target']['columns'][$j]]??null)!==$fk['target']['tableId'])throw new PhysicalGraphError("$path/target/columns/$j");}
            if($fk['name']!==null){if(isset($names[$fk['tableId']][$fk['name']]))throw new PhysicalGraphError("$path/name");$names[$fk['tableId']][$fk['name']]=true;}$budget($fk,$path);$fks[]=$fk;
        }
        $fields=['version'=>$root['version'],'dialect'=>$root['dialect'],'dialectVersion'=>$dialectVersion,'tables'=>$tables,'foreignKeys'=>$fks];$owned=[];foreach(array_keys($root)as$key)$owned[$key]=$fields[$key];return new self($owned);
    }
    public function value():array{return $this->snapshot;}
}
