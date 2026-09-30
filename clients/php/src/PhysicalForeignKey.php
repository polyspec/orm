<?php
declare(strict_types=1);
namespace Orm;

/** Exact physical FK interchange, not dialect execution permission. */
final readonly class PhysicalForeignKey
{
    private function __construct(private array $record){}
    public static function fromValue(mixed $value):self
    {
        $record=PhysicalRecord::shape($value,['id','name','tableId','columns','target','onDelete','onUpdate','match','deferrable','initiallyDeferred','comment','options']);
        $v=new PhysicalRecord();$v->id($record['id']);$v->id($record['tableId']);
        if($record['name']!==null)new PhysicalIdentity(null,null,$v->text($record['name'],1,1024),null);
        $local=$v->ids($record['columns']);$target=PhysicalRecord::shape($record['target'],['tableId','columns']);
        $v->id($target['tableId']);$remote=$v->ids($target['columns']);if(count($local)!==count($remote))throw new \InvalidArgumentException('SCHEMA_INVALID');
        foreach(['onDelete','onUpdate']as$field){
            if(!in_array($v->text($record[$field],1,16),['noAction','restrict','cascade','setNull','setDefault','unspecified'],true))throw new \InvalidArgumentException('SCHEMA_INVALID');
        }
        if(!in_array($v->text($record['match'],1,16),['simple','full','partial','unspecified'],true))throw new \InvalidArgumentException('SCHEMA_INVALID');
        foreach(['deferrable','initiallyDeferred']as$field){if($record[$field]!==null&&!is_bool($record[$field]))throw new \InvalidArgumentException('SCHEMA_INVALID');}
        if($record['initiallyDeferred']===true&&$record['deferrable']!==true)throw new \InvalidArgumentException('SCHEMA_INVALID');
        $v->text($record['comment'],0,8192);$v->options($record['options']);return new self(PhysicalRecord::detached($record));
    }
    public function value():array{return $this->record;}
}
