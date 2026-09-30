<?php
declare(strict_types=1);
namespace Orm;

/** @internal Shared validation for decoded physical records. */
final class PhysicalRecord
{
    private int $bytes=0;
    public static function shape(mixed $value,array $fields):array
    {
        if(!is_array($value)||count($value)!==count($fields)||array_diff($fields,array_keys($value))!==[])throw new \InvalidArgumentException('SCHEMA_INVALID');
        return $value;
    }
    public function text(mixed $value,int $min,int $max):string
    {
        if(!is_string($value)||strlen($value)<$min||strlen($value)>$max||str_contains($value,"\0")||preg_match('//u',$value)!==1)throw new \InvalidArgumentException('SCHEMA_INVALID');
        $this->bytes+=strlen($value);if($this->bytes>65536)throw new \InvalidArgumentException('SCHEMA_INVALID');return $value;
    }
    public function id(mixed $value):string
    {
        $id=$this->text($value,1,128);if(preg_match('/\A[A-Za-z0-9_-]+\z/',$id)!==1)throw new \InvalidArgumentException('SCHEMA_INVALID');return $id;
    }
    public function ids(mixed $value):array
    {
        if(!is_array($value)||!array_is_list($value)||count($value)<1||count($value)>64)throw new \InvalidArgumentException('SCHEMA_INVALID');
        $seen=[];foreach($value as $entry){$id=$this->id($entry);if(isset($seen[$id]))throw new \InvalidArgumentException('SCHEMA_INVALID');$seen[$id]=true;}return $value;
    }
    public function options(mixed $value):void
    {
        if(!is_array($value)||!array_is_list($value)||count($value)>64)throw new \InvalidArgumentException('SCHEMA_INVALID');
        foreach($value as $option){$entry=self::shape($option,['name','value']);$this->text($entry['name'],1,128);$this->text($entry['value'],0,4096);}
    }
    public static function detached(array $value):array
    {
        $copy=[];foreach($value as $key=>$entry){$copy[$key]=is_array($entry)?self::detached($entry):$entry;}return $copy;
    }
}
