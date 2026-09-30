<?php
declare(strict_types=1);
namespace Orm;
final class PhysicalDocumentError extends \RuntimeException {
 public function __construct(private readonly int $sourceLine,private readonly string $sourcePath=''){parent::__construct('SCHEMA_INVALID');}
 public function line():int{return $this->sourceLine;}
 public function path():string{return $this->sourcePath;}
}
