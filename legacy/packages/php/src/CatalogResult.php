<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** A catalog result: the column names in order and the rows of typed values. */
final class CatalogResult
{
    /**
     * @param list<string> $columns
     * @param list<list<mixed>> $rows
     */
    public function __construct(
        public readonly array $columns,
        public readonly array $rows,
    ) {
    }
}
