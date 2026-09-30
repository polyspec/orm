<?php
declare(strict_types=1);
namespace Orm;

final class PhysicalEnvelopeError extends \RuntimeException {
 public function __construct(private readonly int $sourceLine){parent::__construct('SCHEMA_INVALID');}
 public function line():int{return $this->sourceLine;}
}
