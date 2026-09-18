<?php
declare(strict_types=1);

namespace Orm;

/**
 * An ORM function value. It carries the function kind and its arguments; the
 * model method that receives it records the column and the operator, and the
 * engine renders SQL for the connection dialect. Created by Orm::now(),
 * Orm::daysAgo(), Orm::distance(), and the other Orm function factories.
 */
final readonly class Func
{
    /** @param list<int|float> $args */
    public function __construct(public string $name, public array $args, public bool $column) {}

    /** @param callable(mixed): int $param */
    public function ir(callable $param): array
    {
        $out = ['name' => $this->name];
        foreach ($this->args as $a) {
            $out['ps'][] = $param($a);
        }
        return $out;
    }
}
