<?php
declare(strict_types=1);
namespace Orm;

/** Structural primary/unique constraint interchange, not SQL authority. */
final readonly class PhysicalKey
{
    private function __construct(private array $record) {}

    public static function fromValue(mixed $value):self
    {
        $record=PhysicalRecord::shape($value,['id','name','tableId','kind','columns','indexId','deferrable','initiallyDeferred','nullsDistinct','withoutOverlaps','comment','options']);
        $v=new PhysicalRecord();$v->id($record['id']);$v->id($record['tableId']);
        if($record['name']!==null)new PhysicalIdentity(null,null,$v->text($record['name'],1,1024),null);
        $kind=$v->text($record['kind'],1,16);if(!in_array($kind,['primary','unique'],true))throw new \InvalidArgumentException('SCHEMA_INVALID');
        $v->ids($record['columns']);if($record['indexId']!==null)$v->id($record['indexId']);
        foreach(['deferrable','initiallyDeferred','nullsDistinct','withoutOverlaps'] as $field){if($record[$field]!==null&&!is_bool($record[$field]))throw new \InvalidArgumentException('SCHEMA_INVALID');}
        if($record['initiallyDeferred']===true&&$record['deferrable']!==true)throw new \InvalidArgumentException('SCHEMA_INVALID');
        if($kind==='primary'&&$record['nullsDistinct']!==null)throw new \InvalidArgumentException('SCHEMA_INVALID');
        $v->text($record['comment'],0,8192);$v->options($record['options']);
        return new self(PhysicalRecord::detached($record));
    }

    public function value():array {return $this->record;}
}
