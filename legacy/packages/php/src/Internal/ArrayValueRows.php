<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use Polyspec\Orm\GroupRow;
use Polyspec\Orm\Model;

/** @internal */
final class ArrayValueRows
{
    /**
     * @param iterable<Model|GroupRow> $values
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
