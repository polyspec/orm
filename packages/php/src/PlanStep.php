<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal */
final class PlanStep
{
    public int $id = 0;
    public ?PlanAssemble $assemble = null;
    public ?array $parent = null;

    /** @param list<string> $tables The tables the statement uses by name, sorted */
    public function __construct(public string $role, public readonly string $sql, public readonly string $lock, public readonly array $slots, public readonly array $tables)
    {
    }

    public function toArray(): array
    {
        $out = ['id' => $this->id, 'role' => $this->role, 'sql' => $this->sql, 'tables' => $this->tables];
        if ($this->lock !== '') {
            $out['lock'] = $this->lock;
        }
        $out['bind_slots'] = $this->slots;
        if ($this->assemble !== null) {
            $out['assemble'] = $this->assemble->toArray();
        }
        if ($this->parent !== null) {
            $out['parent'] = $this->parent;
        }
        return $out;
    }
}
