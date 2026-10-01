<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Writes a document in its canonical text (docs/dbspec.md#canonical-form), or
 * in the manifest or schema text that View names.
 *
 * @internal Use Dbspec::emit.
 */
final class Emitter
{
    public static function emit(Document $document, View $view): string
    {
        $out = "dbspec 1 {$document->name}\n";
        if ($document->uses !== []) {
            $out .= "\n";
            foreach (self::sorted($document->uses, static fn(UseLine $use): string => $use->document) as $use) {
                $out .= self::comments($use->comments, '', $view) . "use {$use->document} { " . implode(', ', $use->tables) . " }\n";
            }
        }
        foreach ($document->tables as $table) {
            $out .= "\n" . self::table($table, $view);
        }
        if ($view !== View::Canonical) {
            return $out;
        }
        foreach ($document->diagrams as $diagram) {
            $out .= "\n" . self::comments($diagram->comments, '', $view) . "diagram {$diagram->name} {\n";
            foreach ($diagram->placements as $placement) {
                $out .= self::comments($placement->comments, '  ', $view) . "  {$placement->table} at {$placement->x} {$placement->y}\n";
            }
            $out .= self::comments($diagram->closingComments, '  ', $view) . "}\n";
        }
        return $out . ($document->trailingComments === [] ? '' : "\n" . self::comments($document->trailingComments, '', $view));
    }

    private static function table(Table $table, View $view): string
    {
        $out = self::comments($table->comments, '', $view) . "table {$table->name} {\n";
        foreach ($table->columns as $column) {
            $out .= self::comments($column->comments, '  ', $view) . "  {$column->name} " . $column->type->text()
                . ($column->nullable ? ' null' : '')
                . ($column->identity ? ' identity' : '')
                . ($column->default !== null ? " default {$column->default}" : '') . "\n";
        }
        if ($table->primaryKey !== null) {
            $out .= self::comments($table->primaryKey->comments, '  ', $view) . '  primary key (' . implode(', ', $table->primaryKey->columns) . ")\n";
        }
        $byName = static fn(object $constraint): string => $constraint->name;
        foreach (self::sorted($table->uniqueKeys, $byName) as $unique) {
            $out .= self::comments($unique->comments, '  ', $view) . "  unique {$unique->name} (" . implode(', ', $unique->columns) . ")\n";
        }
        foreach (self::sorted($table->indexes, $byName) as $index) {
            $columns = array_map(static fn(IndexColumn $c): string => $c->descending ? "{$c->name} desc" : $c->name, $index->columns);
            $out .= self::comments($index->comments, '  ', $view) . "  index {$index->name} (" . implode(', ', $columns) . ")\n";
        }
        foreach (self::sorted($table->foreignKeys, $byName) as $foreignKey) {
            $out .= self::comments($foreignKey->comments, '  ', $view) . "  foreign key {$foreignKey->name} (" . implode(', ', $foreignKey->columns)
                . ") references {$foreignKey->table} (" . implode(', ', $foreignKey->referencedColumns)
                . ") on delete {$foreignKey->onDelete} on update {$foreignKey->onUpdate}\n";
        }
        foreach (self::sorted($table->checks, $byName) as $check) {
            $out .= self::comments($check->comments, '  ', $view) . "  check {$check->name} ({$check->expression})\n";
        }
        $closingComments = $table->closingComments;
        $written = $table->settings === null ? [] : array_values(array_filter(
            $table->settings->settings,
            static fn(Setting $s): bool => $view !== View::Schema || $s->kind === 'immutable' || $s->kind === 'audit',
        ));
        if ($table->settings !== null && $written === []) {
            // An empty settings block has no meaning and is omitted; its comments stay before the table's `}`.
            $closingComments = [...$table->settings->comments, ...$table->settings->closingComments, ...$closingComments];
        } elseif ($table->settings !== null) {
            $out .= self::comments($table->settings->comments, '  ', $view) . "  settings {\n";
            $rank = array_flip(Setting::KINDS);
            $settings = $written;
            usort($settings, static fn(Setting $a, Setting $b): int => $rank[$a->kind] <=> $rank[$b->kind]
                ?: (($a->kind === 'codec' || $a->kind === 'blind_index' || $a->kind === 'navigation') ? strcmp($a->arguments[0], $b->arguments[0]) : 0));
            foreach ($settings as $setting) {
                $out .= self::comments($setting->comments, '    ', $view) . '    ' . self::setting($setting) . "\n";
            }
            $out .= self::comments($table->settings->closingComments, '    ', $view) . "  }\n";
        }
        return $out . self::comments($closingComments, '  ', $view) . "}\n";
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
    private static function comments(array $comments, string $indent, View $view): string
    {
        if ($view !== View::Canonical) {
            return '';
        }
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
