<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/**
 * A MySQL connection without a server that answers the catalog reads of one described table, default_probe, as a
 * MariaDB server writes them (DIA-205): its COLUMN_DEFAULT is SQL text, and its EXTRA marks no expression default.
 */
class CatalogMariadbDefaultPdo extends CatalogAnswerPdo
{
    /** @param list<array{string, ?string}> $defaults the name and COLUMN_DEFAULT of each column after the key id */
    public function __construct(private readonly array $defaults)
    {
    }

    public function answer(string $query): array
    {
        if ($query === 'SELECT CONNECTION_ID()') {
            // The read session names its connection, which a stop of the read ends (INT-157).
            return [[[7]], ['CONNECTION_ID()'], ['LONGLONG']];
        }
        if (str_starts_with($query, 'SELECT TABLE_TYPE FROM information_schema.TABLES')) {
            return [[['BASE TABLE']], ['TABLE_TYPE'], ['VAR_STRING']];
        }
        if (str_starts_with($query, 'SELECT c.COLUMN_NAME,c.COLUMN_TYPE')) {
            $rows = [['id', 'bigint(20)', 0, 0, 1, 1, null, 0]];
            foreach ($this->defaults as [$name, $default]) {
                $rows[] = [$name, 'varchar(20)', 1, 0, 0, 0, $default, 0];
            }
            return [
                $rows,
                [
                    'COLUMN_NAME', 'COLUMN_TYPE', 'nullable', 'generated', 'ord', 'automatic', 'COLUMN_DEFAULT',
                    'generated_default',
                ],
                ['VAR_STRING', 'BLOB', 'LONGLONG', 'LONGLONG', 'LONGLONG', 'LONGLONG', 'BLOB', 'LONGLONG'],
            ];
        }
        throw new \PDOException("unexpected catalog query: $query");
    }
}
