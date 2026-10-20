<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal */
final class PlanAssemble
{
    public array $columns = [];
    /** @var list<PlanChild> */
    public array $children = [];
    public array $key = [];

    public function __construct(public readonly string $entity, public readonly string $alias)
    {
    }

    public function toArray(): array
    {
        $out = ['entity' => $this->entity, 'alias' => $this->alias, 'columns' => $this->columns];
        if ($this->children !== []) {
            $out['children'] = array_map(static fn(PlanChild $c): array => $c->toArray(), $this->children);
        }
        $out['key'] = $this->key;
        return $out;
    }
}
