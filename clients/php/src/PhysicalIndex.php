<?php
declare(strict_types=1);
namespace Orm;

/** Structural index interchange, not SQL execution permission. */
final readonly class PhysicalIndex
{
    private function __construct(private array $record) {}

    public static function fromValue(mixed $value): self
    {
        $record=PhysicalRecord::shape($value,['id','name','tableId','unique','methodSql','terms','include','predicateSql','nullsDistinct','visible','comment','options']);
        $v=new PhysicalRecord();$v->id($record['id']);$v->id($record['tableId']);
        if($record['name']!==null)new PhysicalIdentity(null,null,$v->text($record['name'],1,1024),null);
        if(!is_bool($record['unique']))throw new \InvalidArgumentException('SCHEMA_INVALID');
        foreach(['nullsDistinct','visible'] as $field){if($record[$field]!==null&&!is_bool($record[$field]))throw new \InvalidArgumentException('SCHEMA_INVALID');}
        self::optionalText($v,$record['methodSql'],128);self::optionalText($v,$record['predicateSql'],16384);
        $terms=$record['terms'];
        if(!is_array($terms)||!array_is_list($terms)||count($terms)<1||count($terms)>64)throw new \InvalidArgumentException('SCHEMA_INVALID');
        foreach($terms as $term)self::term($v,$term);
        $included=$record['include'];
        if(!is_array($included)||!array_is_list($included)||count($included)>64)throw new \InvalidArgumentException('SCHEMA_INVALID');
        $seen=[];foreach($included as $value){$id=$v->id($value);if(isset($seen[$id]))throw new \InvalidArgumentException('SCHEMA_INVALID');$seen[$id]=true;}
        $v->text($record['comment'],0,8192);$v->options($record['options']);
        return new self(PhysicalRecord::detached($record));
    }

    private static function optionalText(PhysicalRecord $v,mixed $value,int $max):void
    {
        if($value!==null)$v->text($value,1,$max);
    }

    private static function term(PhysicalRecord $v,mixed $value):void
    {
        $term=PhysicalRecord::shape($value,['source','order','nulls','collationSql','operatorClassSql','prefixLength']);
        $source=$term['source'];
        if(!is_array($source))throw new \InvalidArgumentException('SCHEMA_INVALID');
        $kind=$v->text($source['kind']??null,1,16);
        if($kind==='column'){$source=PhysicalRecord::shape($source,['kind','columnId']);$v->id($source['columnId']);}
        elseif($kind==='expression'){$source=PhysicalRecord::shape($source,['kind','sql']);$v->text($source['sql'],1,16384);}
        else throw new \InvalidArgumentException('SCHEMA_INVALID');
        if(!in_array($v->text($term['order'],1,16),['asc','desc','unspecified'],true))throw new \InvalidArgumentException('SCHEMA_INVALID');
        if(!in_array($v->text($term['nulls'],1,16),['first','last','unspecified'],true))throw new \InvalidArgumentException('SCHEMA_INVALID');
        self::optionalText($v,$term['collationSql'],1024);self::optionalText($v,$term['operatorClassSql'],4096);
        $prefix=$term['prefixLength'];
        if($prefix!==null&&($kind!=='column'||(!is_int($prefix)&&!is_float($prefix))||$prefix<1||$prefix>2147483647||floor($prefix)!=(float)$prefix))throw new \InvalidArgumentException('SCHEMA_INVALID');
    }

    public function value():array {return $this->record;}
}
