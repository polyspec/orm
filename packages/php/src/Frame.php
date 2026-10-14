<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal the models of one statement and their join paths */
final class Frame
{
    /** @var array<int, string> */
    private array $paths = [];
    /** @var array<int, Model> */
    private array $parents = [];
    /** @var array<int, bool> */
    private array $placed = [];
    private int $rootId;

    public function __construct(private readonly Model $root, private readonly ?Model $outer)
    {
        $this->rootId = spl_object_id($root);
        $this->paths[$this->rootId] = '';
        $root->registerJoins($this, '');
    }

    public function add(Model $child, string $path, Model $parent): void
    {
        $id = spl_object_id($child);
        $this->paths[$id] = $path;
        $this->parents[$id] = $parent;
    }

    public function path(Model $m): string
    {
        return $this->paths[spl_object_id($m)];
    }

    public function joined(Model $m): bool
    {
        $id = spl_object_id($m);
        return $id !== $this->rootId && isset($this->paths[$id]);
    }

    public function parentOf(Model $m): ?Model
    {
        return $this->parents[spl_object_id($m)] ?? null;
    }

    public function place(Model $m): bool
    {
        $id = spl_object_id($m);
        if (isset($this->placed[$id])) {
            return false;
        }
        return $this->placed[$id] = true;
    }

    public function pathOf(Model $m): string
    {
        $id = spl_object_id($m);
        if (isset($this->paths[$id])) {
            return $this->paths[$id];
        }
        if ($this->outer !== null && $m === $this->outer) {
            return '^';
        }
        throw new OrmException(Code::CONFIG, $m::meta()['entity'] . ' is not part of the statement');
    }
}
