<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Checks the element types of the arrays of a document, a document set, a plan and an unsupported list before a dbspec
 * call reads them. PHP's property types do not type the elements of an array, so a document built or edited in PHP can
 * hold another value there; each is a TypeError "<what> holds <value>, not <type>" at the first such element, in the
 * order the document is read: the document's trailing comments, its use lines, its tables (comments, closing
 * comments, columns, primary key, unique keys, indexes, foreign keys, checks, settings) and its diagrams. The
 * extension checks the same elements in the same order with the same messages.
 *
 * @internal
 */
final class Graph
{
    /** Each element of the document set is a Document, and each document is checked. */
    public static function documents(array $documents, string $what): void
    {
        foreach ($documents as $document) {
            self::object($document, Document::class, $what);
            self::document($document);
        }
    }

    /** Each element of the plan list is a Plan, and each plan is checked. */
    public static function plans(array $plans, string $what): void
    {
        foreach ($plans as $plan) {
            self::object($plan, Plan::class, $what);
            self::plan($plan);
        }
    }

    /** Each element of the list is an Unsupported. */
    public static function unsupported(array $unsupported, string $what): void
    {
        foreach ($unsupported as $u) {
            self::object($u, Unsupported::class, $what);
        }
    }

    public static function document(Document $document): void
    {
        self::strings($document->trailingComments, 'Document::$trailingComments');
        foreach ($document->uses as $use) {
            self::object($use, UseLine::class, 'Document::$uses');
            self::strings($use->tables, 'UseLine::$tables');
            self::strings($use->comments, 'UseLine::$comments');
        }
        foreach ($document->tables as $table) {
            self::object($table, Table::class, 'Document::$tables');
            self::table($table);
        }
        foreach ($document->diagrams as $diagram) {
            self::object($diagram, Diagram::class, 'Document::$diagrams');
            self::strings($diagram->comments, 'Diagram::$comments');
            self::strings($diagram->closingComments, 'Diagram::$closingComments');
            foreach ($diagram->placements as $placement) {
                self::object($placement, Placement::class, 'Diagram::$placements');
                self::strings($placement->comments, 'Placement::$comments');
            }
        }
    }

    public static function plan(Plan $plan): void
    {
        foreach ($plan->renameTables as $rename) {
            self::object($rename, TableRename::class, 'Plan::$renameTables');
        }
        foreach ($plan->renameColumns as $rename) {
            self::object($rename, ColumnRename::class, 'Plan::$renameColumns');
        }
        self::strings($plan->dropTables, 'Plan::$dropTables');
        foreach ($plan->dropColumns as $column) {
            self::object($column, ColumnName::class, 'Plan::$dropColumns');
        }
        self::document($plan->schema);
    }

    private static function table(Table $table): void
    {
        self::strings($table->comments, 'Table::$comments');
        self::strings($table->closingComments, 'Table::$closingComments');
        foreach ($table->columns as $column) {
            self::object($column, Column::class, 'Table::$columns');
            foreach ($column->type->parameters as $parameter) {
                if (!is_int($parameter)) {
                    self::fail('ColumnType::$parameters', $parameter, 'an int');
                }
            }
            self::strings($column->comments, 'Column::$comments');
        }
        if ($table->primaryKey !== null) {
            self::strings($table->primaryKey->columns, 'PrimaryKey::$columns');
            self::strings($table->primaryKey->comments, 'PrimaryKey::$comments');
        }
        foreach ($table->uniqueKeys as $unique) {
            self::object($unique, UniqueKey::class, 'Table::$uniqueKeys');
            self::strings($unique->columns, 'UniqueKey::$columns');
            self::strings($unique->comments, 'UniqueKey::$comments');
        }
        foreach ($table->indexes as $index) {
            self::object($index, Index::class, 'Table::$indexes');
            foreach ($index->columns as $column) {
                self::object($column, IndexColumn::class, 'Index::$columns');
            }
            self::strings($index->comments, 'Index::$comments');
        }
        foreach ($table->foreignKeys as $key) {
            self::object($key, ForeignKey::class, 'Table::$foreignKeys');
            self::strings($key->columns, 'ForeignKey::$columns');
            self::strings($key->referencedColumns, 'ForeignKey::$referencedColumns');
            self::strings($key->comments, 'ForeignKey::$comments');
        }
        foreach ($table->checks as $check) {
            self::object($check, Check::class, 'Table::$checks');
            self::strings($check->comments, 'Check::$comments');
        }
        if ($table->settings !== null) {
            self::strings($table->settings->comments, 'Settings::$comments');
            self::strings($table->settings->closingComments, 'Settings::$closingComments');
            foreach ($table->settings->settings as $setting) {
                self::object($setting, Setting::class, 'Settings::$settings');
                self::strings($setting->arguments, 'Setting::$arguments');
                self::strings($setting->comments, 'Setting::$comments');
                foreach (['requires', 'exclude', 'include'] as $list) {
                    if ($setting->$list !== null) {
                        self::strings($setting->$list, "Setting::\$$list");
                    }
                }
            }
        }
    }

    /** @param array<mixed> $values */
    private static function strings(array $values, string $what): void
    {
        foreach ($values as $value) {
            if (!is_string($value)) {
                self::fail($what, $value, 'a string');
            }
        }
    }

    /** @param class-string $class */
    private static function object(mixed $value, string $class, string $what): void
    {
        if (!$value instanceof $class) {
            self::fail($what, $value, $class);
        }
    }

    /** A property name is written with its class's namespace; a description such as "the document set" as it is. */
    private static function fail(string $what, mixed $value, string $want): never
    {
        $where = str_contains($what, '::$') ? __NAMESPACE__ . '\\' . $what : $what;
        throw new \TypeError("$where holds " . self::name($value) . ", not $want");
    }

    /** The value's name as PHP's engine writes it in a type error: the class of an object, true, false, null, int, float, string or array. */
    private static function name(mixed $value): string
    {
        return match (true) {
            $value === true => 'true',
            $value === false => 'false',
            default => get_debug_type($value),
        };
    }
}
