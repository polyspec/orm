<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * The descriptor of a table: its qualified name, its native relation kind, its columns in physical order, its primary key
 * in constraint order and whether that key is a reliable row identity. A descriptor is not authorization for a row change.
 */
final class CatalogTableMetadata
{
    /**
     * @param array{namespace: string, name: string} $table
     * @param list<CatalogColumn> $columns
     * @param list<string> $primaryKey
     */
    public function __construct(
        public readonly array $table,
        public readonly string $kind,
        public readonly array $columns,
        public readonly array $primaryKey,
        public readonly bool $reliableRowIdentity,
    ) {
    }
}
