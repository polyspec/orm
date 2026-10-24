<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal */
final class ArrayValueRows
{
    /**
     * @param iterable<ArrayValue> $values
     * @return list<array<string, mixed>>
     */
    public static function rows(iterable $values): array
    {
        $rows = [];
        foreach ($values as $value) {
            $rows[] = $value->toArray();
        }
        return $rows;
    }
}
