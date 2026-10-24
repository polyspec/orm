<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** @internal */
final class CatalogChecks
{
    /** Adds a decoded catalog check or records why it cannot be represented in dbspec. */
    public static function add(
        Catalog $catalog,
        string $dialect,
        CatalogTable $table,
        string $name,
        string $expression
    ): void {
        try {
            $table->checks[] = [
                'name' => $name,
                'predicate' => CheckDecoder::decode($dialect, $expression, $table->columnTypes()),
            ];
        } catch (CheckDecodeFailure $e) {
            $catalog->report('check', $table->name, $name, $e->getMessage());
        }
    }
}
