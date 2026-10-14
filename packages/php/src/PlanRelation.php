<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal the relation a step loads */
final class PlanRelation
{
    public array $parentKeys = [];
    public array $childKeys = [];
    public string $kind = '';

    public function __construct(public readonly int $parentStep, public readonly PlanAssemble $parentAsm) {}
}
