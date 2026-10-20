<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal */
final class PlanChild
{
    public int $step = 0;
    public array $parentKeys = [];
    public array $childKeys = [];
    public array $key = [];
    public bool $flatten = false;
    public bool $cascade = false;
    public ?PlanAssemble $assemble = null;

    public function __construct(public readonly string $rel, public readonly string $kind)
    {
    }

    public function toArray(): array
    {
        $out = ['rel' => $this->rel, 'kind' => $this->kind];
        foreach (['step' => $this->step, 'parent_keys' => $this->parentKeys, 'child_keys' => $this->childKeys, 'key' => $this->key, 'flatten' => $this->flatten, 'cascade' => $this->cascade] as $k => $v) {
            if ($v !== 0 && $v !== [] && $v !== false) {
                $out[$k] = $v;
            }
        }
        if ($this->assemble !== null) {
            $out['assemble'] = $this->assemble->toArray();
        }
        return $out;
    }
}
