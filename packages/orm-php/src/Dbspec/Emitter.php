<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

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
            usort($settings, static fn(Setting $a, Setting $b): int => $rank[$a->kind] <=> $rank[$b->kind] ?: self::within($a, $b));
            foreach ($settings as $setting) {
                $out .= self::comments($setting->comments, '    ', $view) . '    ' . self::setting($setting, $table, $view) . "\n";
            }
            $out .= self::comments($table->settings->closingComments, '    ', $view) . "  }\n";
        }
        return $out . self::comments($closingComments, '  ', $view) . "}\n";
    }

    /**
     * 같은 종류의 설정 두 개의 순서다: codec, blind_index, navigation과 markdown은 column 또는
     * foreign key 이름순이고, state_machine 줄은 선언 순서를 지키고 history 줄, limit 줄 순이다
     * (Go의 emitter가 그 순서로 쓴다). 나머지는 선언 순서를 지킨다.
     */
    private static function within(Setting $a, Setting $b): int
    {
        return match ($a->kind) {
            'codec', 'blind_index', 'navigation', 'markdown' => strcmp($a->arguments[0], $b->arguments[0]),
            'state_machine' => self::machineRank($a) <=> self::machineRank($b),
            default => 0,
        };
    }

    private static function machineRank(Setting $setting): int
    {
        return match ($setting->form) {
            'history' => 1,
            'limit' => 2,
            default => 0,
        };
    }

    private static function setting(Setting $setting, Table $table, View $view): string
    {
        return match ($setting->kind) {
            'select_explicit' => 'select explicit ' . implode(' ', $setting->arguments),
            'key_prefix' => 'key_prefix ' . self::quote($setting->arguments[0]),
            'checkbox' => "checkbox {$setting->arguments[0]} {$setting->arguments[1]} " . self::quote($setting->arguments[2]),
            'state_machine' => self::machine($setting),
            // schema text는 database 상태로 정해지므로 기록하지 않는 column을 column 순서의 exclude
            // 목록으로 쓴다. 다른 view는 쓴 목록을 그대로 쓴다.
            'audit' => match (true) {
                $view === View::Schema => $setting->auditLine('exclude', $setting->excluded($table)),
                $setting->include !== null => $setting->auditLine('include', $setting->include),
                default => $setting->auditLine('exclude', $setting->exclude),
            },
            default => implode(' ', [$setting->kind, ...$setting->arguments]),
        };
    }

    /** state_machine 줄 하나다: transition, initial 또는 terminal state, history 또는 limit. */
    private static function machine(Setting $setting): string
    {
        $column = $setting->arguments[0];
        $rest = array_slice($setting->arguments, 1);
        $text = match ($setting->form) {
            'initial' => "state_machine $column initial {$rest[0]}",
            'terminal' => "state_machine $column terminal {$rest[0]}",
            'history' => "state_machine $column history {$rest[0]} row {$rest[1]} from {$rest[2]} to {$rest[3]} at {$rest[4]}",
            'limit' => "state_machine $column limit {$rest[0]} " . ltrim($rest[1], '0'),
            default => "state_machine $column {$rest[0]} -> {$rest[1]}",
        };
        if ($setting->requires !== null && $setting->requires !== []) {
            $text .= ' require (' . implode(', ', $setting->requires) . ')';
        }
        return $text;
    }

    /** 표준 text의 문자열 literal이다: 작은따옴표 사이 값이며 따옴표는 두 번 쓴다. */
    private static function quote(string $value): string
    {
        return "'" . str_replace("'", "''", $value) . "'";
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
