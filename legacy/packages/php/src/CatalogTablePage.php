<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * One bounded page of a table in primary-key order. hasMore reports one row beyond the page, found by a sentinel row;
 * it is not a total count. A page is not authorization for a row change.
 */
final class CatalogTablePage
{
    /** @param list<string> $orderBy */
    public function __construct(
        public readonly CatalogTableMetadata $metadata,
        public readonly CatalogResult $result,
        public readonly int $limit,
        public readonly int $offset,
        public readonly array $orderBy,
        public readonly bool $hasMore,
    ) {
    }

    /** The position of the named column in the rows of the page. */
    public function columnIndex(string $name): int
    {
        foreach ($this->metadata->columns as $i => $column) {
            if ($column->name === $name) {
                return $i;
            }
        }
        throw new OrmException(Code::COLUMN_UNKNOWN, "table page has no column $name");
    }
}
