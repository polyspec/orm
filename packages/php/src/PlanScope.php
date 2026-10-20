<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal one entity occurrence of a statement: the root, a join, or a subquery root */
final class PlanScope
{
    /** @var array<string, PlanScope> */
    public array $joins = [];
    public ?PlanScope $outer = null;
    /** @var list<string> columns a relation step needs selected */
    public array $extra = [];

    public function __construct(public readonly array $ent, public readonly string $alias, public readonly array $q, public readonly ?PlanScope $parent)
    {
    }
}
