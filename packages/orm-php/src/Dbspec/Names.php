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

    /** 이름 `<table>$<suffix>`(suffix 는 column 이나 event)를 renderer 가 쓰는 이름으로 만든다. */
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
     * each name; never splits $name on $.
     *
     * @param iterable<string> $columns
     */
    public static function column(string $table, string $name, iterable $columns): ?string
    {
        foreach ($columns as $column) {
            if (self::render($table, $column) === $name) {
                return $column;
            }
        }
        return null;
    }
}
