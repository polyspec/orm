<?php
declare(strict_types=1);
namespace Orm;

/** Exact qualified database names, not logical model identifiers. */
final readonly class PhysicalIdentity
{
    private array $components;
    private string $identityKey;

    public function __construct(?string $catalog, ?string $schema, string $table, ?string $column)
    {
        $parts=[$catalog,$schema,$table,$column];
        $tokens=[];
        foreach($parts as $part){
            if($part===null){$tokens[]='-';continue;}
            if($part===''||strlen($part)>1024||preg_match('//u',$part)!==1||preg_match('/[\x00-\x1f\x7f]/',$part)===1){
                throw new \InvalidArgumentException('SCHEMA_INVALID');
            }
            $tokens[]=bin2hex($part);
        }
        $this->components=$parts;
        $this->identityKey='p1:'.implode('.',$tokens);
    }

    public function key():string {return $this->identityKey;}
    public function parts():array {return $this->components;}
}
