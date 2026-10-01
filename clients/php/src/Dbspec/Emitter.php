<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Writes a document in its canonical text (docs/dbspec.md#canonical-form).
 *
 * @internal Use Dbspec::emit.
 */
final class Emitter
{
    public static function emit(Document $document): string
    {
        $out = "dbspec 1 {$document->name}\n";
        if ($document->uses !== []) {
            $out .= "\n";
            foreach (self::sorted($document->uses, static fn(UseLine $use): string => $use->document) as $use) {
                $out .= self::comments($use->comments, '') . "use {$use->document} { " . implode(', ', $use->tables) . " }\n";
            }
        }
        foreach ($document->tables as $table) {
            $out .= "\n" . self::table($table);
        }
        foreach ($document->diagrams as $diagram) {
            $out .= "\n" . self::comments($diagram->comments, '') . "diagram {$diagram->name} {\n";
            foreach ($diagram->placements as $placement) {
                $out .= self::comments($placement->comments, '  ') . "  {$placement->table} at {$placement->x} {$placement->y}\n";
            }
            $out .= self::comments($diagram->closingComments, '') . "}\n";
        }
        return $out . self::comments($document->trailingComments, '');
    }

    private static function table(Table $table): string
    {
        $out = self::comments($table->comments, '') . "table {$table->name} {\n";
        foreach ($table->columns as $column) {
            $out .= self::comments($column->comments, '  ') . "  {$column->name} " . $column->type->text()
                . ($column->nullable ? ' null' : '')
                . ($column->identity ? ' identity' : '')
                . ($column->default !== null ? " default {$column->default}" : '') . "\n";
        }
        if ($table->primaryKey !== null) {
            $out .= self::comments($table->primaryKey->comments, '  ') . '  primary key (' . implode(', ', $table->primaryKey->columns) . ")\n";
        }
        $byName = static fn(object $constraint): string => $constraint->name;
        foreach (self::sorted($table->uniqueKeys, $byName) as $unique) {
            $out .= self::comments($unique->comments, '  ') . "  unique {$unique->name} (" . implode(', ', $unique->columns) . ")\n";
        }
        foreach (self::sorted($table->indexes, $byName) as $index) {
            $columns = array_map(static fn(IndexColumn $c): string => $c->descending ? "{$c->name} desc" : $c->name, $index->columns);
            $out .= self::comments($index->comments, '  ') . "  index {$index->name} (" . implode(', ', $columns) . ")\n";
        }
        foreach (self::sorted($table->foreignKeys, $byName) as $foreignKey) {
            $out .= self::comments($foreignKey->comments, '  ') . "  foreign key {$foreignKey->name} (" . implode(', ', $foreignKey->columns)
                . ") references {$foreignKey->table} (" . implode(', ', $foreignKey->referencedColumns)
                . ") on delete {$foreignKey->onDelete} on update {$foreignKey->onUpdate}\n";
        }
        foreach (self::sorted($table->checks, $byName) as $check) {
            $out .= self::comments($check->comments, '  ') . "  check {$check->name} ({$check->expression})\n";
        }
        if ($table->settings !== null) {
            $out .= self::comments($table->settings->comments, '  ') . "  settings {\n";
            $rank = array_flip(Setting::KINDS);
            $settings = $table->settings->settings;
            usort($settings, static fn(Setting $a, Setting $b): int => $rank[$a->kind] <=> $rank[$b->kind]
                ?: (($a->kind === 'codec' || $a->kind === 'navigation') ? strcmp($a->arguments[0], $b->arguments[0]) : 0));
            foreach ($settings as $setting) {
                $out .= self::comments($setting->comments, '    ') . '    ' . self::setting($setting) . "\n";
            }
            $out .= self::comments($table->settings->closingComments, '  ') . "  }\n";
        }
        return $out . self::comments($table->closingComments, '') . "}\n";
    }

    private static function setting(Setting $setting): string
    {
        return match ($setting->kind) {
            'select_explicit' => 'select explicit ' . implode(' ', $setting->arguments),
            'audit' => "audit into {$setting->arguments[0]} operation {$setting->arguments[1]} action {$setting->arguments[2]} previous {$setting->arguments[3]}",
            default => implode(' ', [$setting->kind, ...$setting->arguments]),
        };
    }

    /** @param list<string> $comments */
    private static function comments(array $comments, string $indent): string
    {
        $out = '';
        foreach ($comments as $comment) {
            $out .= $indent . $comment . "\n";
        }
        return $out;
    }

    /**
     * Sorts by a name in byte order; equal names keep their order.
     *
     * @template T
     * @param list<T> $items
     * @return list<T>
     */
    private static function sorted(array $items, \Closure $name): array
    {
        if (count($items) > 1) {
            usort($items, static fn(object $a, object $b): int => strcmp($name($a), $name($b)));
        }
        return $items;
    }
}
