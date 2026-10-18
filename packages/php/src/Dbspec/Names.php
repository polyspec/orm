<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The names that the renderer writes (docs/dbspec.md "Names"): the plain form
 * `<table>$<suffix>` when it has at most 63 bytes, otherwise its first 54 bytes,
 * a `$` and the first 8 lowercase hexadecimal digits of its SHA-256.
 */
final class Names
{
    private const LIMIT = 63;
    private const HASH_DIGITS = 8;
    private const PREFIX_BYTES = self::LIMIT - 1 - self::HASH_DIGITS;

    /** Makes the name `<table>$<suffix>` (the suffix is a column or event) into the name the renderer writes. */
    public static function render(string $table, string $suffix): string
    {
        $plain = $table . '$' . $suffix;
        if (strlen($plain) <= self::LIMIT) {
            return $plain;
        }
        return substr($plain, 0, self::PREFIX_BYTES) . '$' . substr(hash('sha256', $plain), 0, self::HASH_DIGITS);
    }

    /**
     * The renderer names that a table writes: the type CHECK of each column that has one, and
     * the triggers of immutable and audit.
     *
     * @return list<string>
     */
    public static function ofTable(Table $table): array
    {
        $names = [];
        foreach ($table->columns as $column) {
            if (!$column->identity && !in_array($column->type->name, ['text', 'bytes'], true)) {
                $names[] = self::render($table->name, $column->name);
            }
        }
        foreach ($table->settings?->settings ?? [] as $setting) {
            $events = match ($setting->kind) {
                'immutable' => ['immutable_update', 'immutable_delete'],
                'audit' => ['audit_insert', 'audit_update', 'audit_delete'],
                default => [],
            };
            foreach ($events as $event) {
                $names[] = self::render($table->name, $event);
            }
        }
        return $names;
    }

    /**
     * The column among $columns whose renderer name is $name, or null. Recomputes
     * each name; never splits $name on $. An element that is not a string is a
     * TypeError of this argument.
     *
     * @param Traversable<int, string>|array<int, string> $columns
     */
    public static function column(string $table, string $name, \Traversable|array $columns): ?string
    {
        foreach ($columns as $column) {
            if (!is_string($column)) {
                $given = match (true) {
                    $column === true => 'true',
                    $column === false => 'false',
                    default => get_debug_type($column),
                };
                throw new \TypeError(__METHOD__ . "(): Argument #3 (\$columns) must contain only strings, $given given");
            }
            if (self::render($table, $column) === $name) {
                return $column;
            }
        }
        return null;
    }
}
