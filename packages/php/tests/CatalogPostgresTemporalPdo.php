<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;

/**
 * A PostgreSQL connection without a server that answers the catalog reads of one described table, temporal_probe, whose
 * temporal columns hold the text that PostgreSQL sends: a timestamp, a time and a date, each with the fraction digits
 * that PostgreSQL writes, which leaves out trailing zeros.
 */
final class CatalogPostgresTemporalPdo extends CatalogAnswerPdo
{
    /**
     * @param list<array{string, string}> $columns the name and native type of each column after the key id
     * @param list<mixed> $cells the cells of the one row after its key
     */
    public function __construct(private readonly array $columns, private readonly array $cells)
    {
    }

    public function answer(string $query): array
    {
        if (str_starts_with($query, 'SELECT c.relkind::text')) {
            return [[['r']], ['relkind'], ['text']];
        }
        if (str_starts_with($query, 'SELECT a.attname::text')) {
            $rows = [['id', 'bigint', false, false, 1, false, null, false]];
            foreach ($this->columns as [$name, $type]) {
                $rows[] = [$name, $type, true, false, 0, false, null, false];
            }
            return [
                $rows,
                ['attname', 'format_type', 'nullable', 'generated', 'ord', 'automatic', 'expr', 'has_default'],
                ['text', 'text', 'bool', 'bool', 'int8', 'bool', 'text', 'bool'],
            ];
        }
        if (str_starts_with($query, 'SELECT "id",') && str_contains($query, ' FROM "public"."temporal_probe"')) {
            $names = array_merge(['id'], array_column($this->columns, 0));
            return [[array_merge([1], $this->cells)], $names, array_fill(0, count($names), 'text')];
        }
        throw new RuntimeException("unexpected catalog query: $query");
    }
}
