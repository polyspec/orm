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
    /** The select of the open cursor, until its first fetch. */
    private ?string $cursorSelect = null;
    /** @var array{list<string>, list<string>}|null the names and types of the fetched select */
    private ?array $fetchedNames = null;

    /**
     * @param list<array{string, string}> $columns the name and native type of each column after the key id
     * @param list<mixed> $cells the cells of the one row after its key
     */
    public function __construct(private readonly array $columns, private readonly array $cells)
    {
    }

    public function exec(string $statement): int|false
    {
        // The cursor statements of a streamed read run through exec; transaction statements have no answer.
        if (str_starts_with($statement, 'DECLARE ') || str_starts_with($statement, 'CLOSE ')) {
            $this->answer($statement);
        }
        return 0;
    }

    public function answer(string $query): array
    {
        $settings = ['ISO, MDY', 'postgres', 'UTC', '1', 'hex', 'C', '"$user", public'];
        if (str_starts_with($query, 'SELECT current_setting(')) {
            // The output settings of the session (INT-186).
            return [[$settings], array_fill(0, count($settings), 'current_setting'), array_fill(0, 7, 'text')];
        }
        $wrapper = "WITH catalog_read AS MATERIALIZED (\n";
        if (str_starts_with($query, $wrapper)) {
            // A read of cells carries the output settings after the columns of each row (INT-186).
            $end = (int) strrpos($query, "\n) SELECT catalog_read.*, ");
            [$rows, $names, $types] = $this->answer(substr($query, strlen($wrapper), $end - strlen($wrapper)));
            return [
                array_map(static fn (array $row): array => array_merge($row, $settings), $rows),
                array_merge($names, array_fill(0, count($settings), 'current_setting')),
                array_merge($types, array_fill(0, count($settings), 'text')),
            ];
        }
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
        if (str_starts_with($query, 'DECLARE ')) {
            // A streamed read declares its cursor over the select; the select is answered when the cursor is fetched.
            $this->cursorSelect = substr($query, (int) strpos($query, ' FOR ') + 5);
            return [[], [], []];
        }
        if (str_starts_with($query, 'FETCH FORWARD ')) {
            // The first fetch returns the whole select; a later fetch reads past its end and returns no rows.
            if ($this->cursorSelect !== null) {
                [$rows, $names, $types] = $this->answer($this->cursorSelect);
                $this->cursorSelect = null;
                $this->fetchedNames = [$names, $types];
                return [$rows, $names, $types];
            }
            if ($this->fetchedNames === null) {
                throw new RuntimeException("unexpected catalog query: $query");
            }
            return [[], $this->fetchedNames[0], $this->fetchedNames[1]];
        }
        if (str_starts_with($query, 'CLOSE ')) {
            return [[], [], []];
        }
        if (str_starts_with($query, 'SELECT "id",') && str_contains($query, ' FROM "public"."temporal_probe"')) {
            $names = array_merge(['id'], array_column($this->columns, 0));
            return [[array_merge([1], $this->cells)], $names, array_fill(0, count($names), 'text')];
        }
        throw new RuntimeException("unexpected catalog query: $query");
    }
}
