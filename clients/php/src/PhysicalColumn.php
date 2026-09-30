<?php
declare(strict_types=1);
namespace Orm;

/** Structural physical interchange, not permission to execute SQL. */
final readonly class PhysicalColumn
{
    private function __construct(private array $record) {}

    private static function shape(mixed $value,array $fields):array
    {
        if(!is_array($value)||count($value)!==count($fields)||array_diff($fields,array_keys($value))!==[]){
            throw new \InvalidArgumentException('SCHEMA_INVALID');
        }
        return $value;
    }

    public static function fromValue(mixed $value):self
    {
        $record=self::shape($value,['id','name','typeSql','nullable','default','generation','comment','options']);
        $bytes=0;
        $text=static function(mixed $value,int $min,int $max)use(&$bytes):string{
            if(!is_string($value)||strlen($value)<$min||strlen($value)>$max||str_contains($value,"\0")||preg_match('//u',$value)!==1){
                throw new \InvalidArgumentException('SCHEMA_INVALID');
            }
            $bytes+=strlen($value);if($bytes>65536)throw new \InvalidArgumentException('SCHEMA_INVALID');
            return $value;
        };
        $id=$text($record['id'],1,128);
        if(preg_match('/\A[A-Za-z0-9_-]+\z/',$id)!==1)throw new \InvalidArgumentException('SCHEMA_INVALID');
        new PhysicalIdentity(null,null,$text($record['name'],1,1024),null);
        $text($record['typeSql'],1,4096);$text($record['comment'],0,8192);
        if(!is_bool($record['nullable']))throw new \InvalidArgumentException('SCHEMA_INVALID');
        $default=$record['default'];
        if(!is_array($default))throw new \InvalidArgumentException('SCHEMA_INVALID');
        $kind=$text($default['kind']??null,1,16);
        if(in_array($kind,['absent','null'],true))self::shape($default,['kind']);
        elseif(in_array($kind,['literal','expression'],true)){
            self::shape($default,['kind','sql']);$text($default['sql'],1,16384);
        }else throw new \InvalidArgumentException('SCHEMA_INVALID');
        $generation=$record['generation'];
        if(!is_array($generation))throw new \InvalidArgumentException('SCHEMA_INVALID');
        $kind=$text($generation['kind']??null,1,16);
        if($kind==='none')self::shape($generation,['kind']);
        elseif($kind==='identity'){
            self::shape($generation,['kind','sql']);$text($generation['sql'],1,16384);
        }elseif($kind==='computed'){
            self::shape($generation,['kind','sql','storage']);$text($generation['sql'],1,16384);
            if(!in_array($text($generation['storage'],1,16),['stored','virtual','unspecified'],true))throw new \InvalidArgumentException('SCHEMA_INVALID');
        }else throw new \InvalidArgumentException('SCHEMA_INVALID');
        $options=$record['options'];
        if(!is_array($options)||!array_is_list($options)||count($options)>64)throw new \InvalidArgumentException('SCHEMA_INVALID');
        foreach($options as $option){
            $entry=self::shape($option,['name','value']);$text($entry['name'],1,128);$text($entry['value'],0,4096);
        }
        return new self(self::detached($record));
    }

    private static function detached(array $value):array
    {
        $copy=[];
        foreach($value as $key=>$entry){$copy[$key]=is_array($entry)?self::detached($entry):$entry;}
        return $copy;
    }

    public function value():array {return $this->record;}
}
