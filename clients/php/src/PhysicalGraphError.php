<?php
declare(strict_types=1);
namespace Orm;

final class PhysicalGraphError extends \InvalidArgumentException
{
    public function __construct(private readonly string $location){parent::__construct('SCHEMA_INVALID');}
    public function path():string{return $this->location;}
}
