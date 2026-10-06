<?php

/**
 * @generate-class-entries
 */

/*
 * PHP 확장 orm_dbspec이 등록하는 class의 선언이다. 실행 시 load하지 않는다: 확장이 있으면 같은 이름의 class를
 * 확장이 등록한다. 선언은 interface 검사(contracts/interfaces.json의 php-extension)의 inventory이고,
 * clients/php-extension/scripts/arginfo.php가 gen_stub.php로 src/orm_dbspec_arginfo.h를 만들며,
 * clients/php-extension/tests/declarations_test.php가 load한 확장의 Reflection과 이 file의 Reflection이 같은지
 * 확인한다. class와 그 property, 메서드는 PHP client(clients/php/src/Dbspec)의 같은 이름 class와 같다. gen_stub은
 * 배열 상수를 쓰지 못하므로 src/orm_dbspec.c가 등록하고, 반환 type에 `self` 대신 class 이름을 쓴다.
 */

namespace Polyspec\Orm\Dbspec\Native;

/** One SCHEMA_INVALID finding: the rule, the 1-based line and column of the offending token, and a message. */
final readonly class Diagnostic
{
    public string $rule;
    public int $line;
    public int $column;
    public string $message;

    public function __construct(string $rule, int $line, int $column, string $message) {}
}

/** A parsed dbspec document. Comments are kept with the line that follows them. */
final class Document
{
    public array $uses = [];
    public array $tables = [];
    public array $diagrams = [];
    public array $trailingComments = [];
    public bool $external = false;
    public string $name;

    public function __construct(string $name) {}
}

/** `use <document> { <table>, ... }`: tables of another document available as foreign key targets. */
final class UseLine
{
    public string $document;
    public array $tables;
    public array $comments;

    public function __construct(string $document, array $tables, array $comments = []) {}
}

final class Table
{
    public array $columns = [];
    public ?PrimaryKey $primaryKey = null;
    public array $uniqueKeys = [];
    public array $indexes = [];
    public array $foreignKeys = [];
    public array $checks = [];
    public ?Settings $settings = null;
    public array $closingComments = [];
    public string $name;
    public array $comments;

    public function __construct(string $name, array $comments = []) {}
}

/** `<name> <type> [null] [identity] [default <value>]`; the default is its canonical literal text or `now`. */
final class Column
{
    public string $name;
    public ColumnType $type;
    public bool $nullable;
    public bool $identity;
    public ?string $default;
    public array $comments;

    public function __construct(string $name, ColumnType $type, bool $nullable, bool $identity, ?string $default, array $comments = []) {}
}

/** A dbspec type: `i16`, `decimal(13,2)`, `varchar(64)`, `time(0)` and the others of the type table. */
final readonly class ColumnType
{
    public const array SIMPLE = ['i16', 'i32', 'i64', 'bool', 'f64', 'text', 'bytes', 'uuid', 'date'];
    public const array PARAMETERIZED = ['decimal' => 2, 'varchar' => 1, 'time' => 1, 'datetime' => 1];

    public string $name;
    public array $parameters;

    public function __construct(string $name, array $parameters = []) {}

    public function text(): string {}

    public function isInteger(): bool {}
}

final class PrimaryKey
{
    public array $columns;
    public array $comments;

    public function __construct(array $columns, array $comments = []) {}
}

final class UniqueKey
{
    public string $name;
    public array $columns;
    public array $comments;

    public function __construct(string $name, array $columns, array $comments = []) {}
}

final class Index
{
    public string $name;
    public array $columns;
    public array $comments;

    public function __construct(string $name, array $columns, array $comments = []) {}
}

final readonly class IndexColumn
{
    public string $name;
    public bool $descending;

    public function __construct(string $name, bool $descending) {}
}

/** A named foreign key; actions are `restrict`, `cascade` or `set_null`. */
final class ForeignKey
{
    public const array ACTIONS = ['restrict', 'cascade', 'set_null'];

    public string $name;
    public array $columns;
    public string $table;
    public array $referencedColumns;
    public string $onDelete;
    public string $onUpdate;
    public array $comments;

    public function __construct(string $name, array $columns, string $table, array $referencedColumns, string $onDelete, string $onUpdate, array $comments = []) {}

    /** True when an action changes child rows: `cascade` or `set_null` on delete or update. */
    public function changesChildRows(): bool {}
}

/** A named check; the expression is held in its canonical text. */
final class Check
{
    public string $name;
    public string $expression;
    public array $comments;

    public function __construct(string $name, string $expression, array $comments = []) {}
}

/** The `settings { ... }` block of a table. */
final class Settings
{
    public array $settings = [];
    public array $closingComments = [];
    public array $comments;

    public function __construct(array $comments = []) {}
}

/** One setting line; `audit` holds the history table, the audit column, the audit record table, the action and previous columns. */
final class Setting
{
    public const array KINDS = ['entity', 'updated', 'soft_delete', 'select_explicit', 'codec', 'aes_version', 'blind_index', 'navigation', 'immutable', 'audit'];
    public const array CODEC_STAGES = ['ordered_json', 'aes', 'hex', 'gz', 'base64', 'serialize', 'yaml', 'ip'];

    public string $kind;
    public array $arguments;
    public array $comments;
    public ?array $exclude;
    public ?array $include;

    public function __construct(string $kind, array $arguments, array $comments = [], ?array $exclude = null, ?array $include = null) {}

    public function records(string $column): bool {}

    public function excluded(Table $table): array {}

    public function auditLine(string $list, ?array $columns): string {}
}

final class Diagram
{
    public array $placements = [];
    public array $closingComments = [];
    public string $name;
    public array $comments;

    public function __construct(string $name, array $comments = []) {}
}

/** `<table> at <x> <y>` in a diagram. */
final class Placement
{
    public string $table;
    public int $x;
    public int $y;
    public array $comments;

    public function __construct(string $table, int $x, int $y, array $comments = []) {}
}

/** The outcome of Dbspec::readFile and Dbspec::readBytes: the file text and no diagnostics, or the diagnostics and no text. */
final readonly class ReadResult
{
    public ?string $text;
    public array $diagnostics;

    private function __construct(?string $text, array $diagnostics) {}

    public static function valid(string $text): ReadResult {}

    public static function invalid(array $diagnostics): ReadResult {}
}

/** The outcome of Dbspec::parse: a document and no diagnostics, or every diagnostic in source order and no document. */
final readonly class ParseResult
{
    public ?Document $document;
    public array $diagnostics;

    private function __construct(?Document $document, array $diagnostics) {}

    public static function valid(Document $document): ParseResult {}

    public static function invalid(array $diagnostics): ParseResult {}
}

/** The manifest and schema texts of a document set and their hashes (docs/dbspec.md, "Manifest and hashes"). */
final readonly class Manifest
{
    public string $manifestText;
    public string $schemaText;
    public string $manifestHash;
    public string $schemaHash;
    public string $externalText;

    public function __construct(string $manifestText, string $schemaText, string $manifestHash, string $schemaHash, string $externalText = '') {}
}

/** The outcome of Dbspec::manifest: a manifest and no diagnostics, or the diagnostics and no manifest. */
final readonly class ManifestResult
{
    public ?Manifest $manifest;
    public array $diagnostics;

    private function __construct(?Manifest $manifest, array $diagnostics) {}

    public static function valid(Manifest $manifest): ManifestResult {}

    public static function invalid(array $diagnostics): ManifestResult {}
}

/** The outcome of Dbspec::render: the statements and no diagnostics, or the diagnostics and no statements. */
final readonly class RenderResult
{
    public ?array $statements;
    public array $diagnostics;

    private function __construct(?array $statements, array $diagnostics) {}

    public static function valid(array $statements): RenderResult {}

    public static function invalid(array $diagnostics): RenderResult {}
}

/** A parsed plan document; `from` is null for a plan from an empty database, `to` the schemaHash of its target. */
final readonly class Plan
{
    public string $name;
    public ?string $from;
    public array $renameTables;
    public array $renameColumns;
    public array $dropTables;
    public array $dropColumns;
    public Document $schema;
    public string $to;

    public function __construct(string $name, ?string $from, array $renameTables, array $renameColumns, array $dropTables, array $dropColumns, Document $schema, string $to) {}
}

/** One step of a plan (docs/plans.md "Steps"). */
final readonly class PlanStep
{
    public string $statement;
    public string $rollback;
    public string $irreversible;
    public Effect $effect;
    public string $restore;
    public string $rollbackRestore;
    public ?Effect $restoreIf;
    public array $nullChecks;
    public bool $finalize;

    public function __construct(string $statement, string $rollback, string $irreversible, Effect $effect, string $restore = '', string $rollbackRestore = '', ?Effect $restoreIf = null, array $nullChecks = [], bool $finalize = false) {}
}

/** How a step's statement shows that it took effect (docs/plans.md "Steps", effects). */
final readonly class Effect
{
    public string $kind;
    public string $table;
    public string $name;
    public bool $present;

    public function __construct(string $kind, string $table, string $name, bool $present) {}

    public static function repeat(): Effect {}

    /** The text form of docs/plans.md "Effects", such as `present table users`. */
    public function text(): string {}
}

/** A column that a rollback statement makes non-null again: its table, its name and the SQL text of its source default. */
final readonly class NullCheck
{
    public string $table;
    public string $column;
    public ?string $default;

    public function __construct(string $table, string $column, ?string $default) {}
}

/** One change of a plan's diff (docs/plans.md "Diff"). */
final readonly class Change
{
    public string $kind;
    public string $table;
    public string $name;

    public function __construct(string $kind, string $table, string $name) {}
}

/** One difference of two schemas (docs/plans.md "Comparison"). */
final readonly class Difference
{
    public string $kind;
    public string $table;
    public string $name;

    public function __construct(string $kind, string $table, string $name) {}
}

/** An object that introspection or Mermaid cannot carry into dbspec, or out of it. */
final readonly class Unsupported
{
    public string $kind;
    public string $table;
    public string $name;
    public string $reason;

    public function __construct(string $kind, string $table, string $name, string $reason) {}
}

/** `rename table <old> <new>` of a plan. */
final readonly class TableRename
{
    public string $old;
    public string $new;

    public function __construct(string $old, string $new) {}
}

/** `rename column <table>.<old> <new>` of a plan; the table is its name in the target. */
final readonly class ColumnRename
{
    public string $table;
    public string $old;
    public string $new;

    public function __construct(string $table, string $old, string $new) {}
}

/** The source table and column of `allow drop column <table>.<name>`. */
final readonly class ColumnName
{
    public string $table;
    public string $name;

    public function __construct(string $table, string $name) {}
}

/** One occurrence of apply, recover, rollback or finalize (docs/plans.md "Apply"). */
final readonly class ApplyEvent
{
    public string $kind;
    public string $plan;
    public int $step;
    public int $steps;
    public string $statement;

    public function __construct(string $kind, string $plan, int $step, int $steps, string $statement) {}
}

/** A failure of apply or recover (docs/plans.md "Apply"). */
final class ApplyError extends \RuntimeException
{
    public readonly string $code_;
    public readonly string $plan;
    public readonly int $step;
    public readonly string $detail;

    public function __construct(string $code_, string $plan, int $step, string $detail, ?\Throwable $previous = null) {}
}

/** A failure of apply or recover after which cleanup failed too; `cleanup` lists the cleanup errors in order. */
final class ApplyCleanupError extends \RuntimeException
{
    public readonly array $cleanup;

    public function __construct(\Throwable $failure, array $cleanup) {}
}

/** The outcome of Dbspec::parsePlan: a plan and no diagnostics, or the diagnostics and no plan. */
final readonly class PlanParseResult
{
    public ?Plan $plan;
    public array $diagnostics;

    private function __construct(?Plan $plan, array $diagnostics) {}

    public static function valid(Plan $plan): PlanParseResult {}

    public static function invalid(array $diagnostics): PlanParseResult {}
}

/** The outcome of Dbspec::planSteps: the steps and no diagnostics, or the diagnostics and no steps. */
final readonly class PlanStepsResult
{
    public ?array $steps;
    public array $diagnostics;

    private function __construct(?array $steps, array $diagnostics) {}

    public static function valid(array $steps): PlanStepsResult {}

    public static function invalid(array $diagnostics): PlanStepsResult {}
}

/** The outcome of Dbspec::chain: the plans in chain order and no diagnostics, or the diagnostics and no plans. */
final readonly class ChainResult
{
    public ?array $plans;
    public array $diagnostics;

    private function __construct(?array $plans, array $diagnostics) {}

    public static function valid(array $plans): ChainResult {}

    public static function invalid(array $diagnostics): ChainResult {}
}

/** The outcome of Dbspec::diff: the changes and no diagnostics, or the diagnostics and no changes. */
final readonly class DiffResult
{
    public ?array $changes;
    public array $diagnostics;

    private function __construct(?array $changes, array $diagnostics) {}

    public static function valid(array $changes): DiffResult {}

    public static function invalid(array $diagnostics): DiffResult {}
}

/** The outcome of Dbspec::compareSchemas: the differences and no diagnostics, or the diagnostics and no differences. */
final readonly class ComparisonResult
{
    public ?array $differences;
    public array $diagnostics;

    private function __construct(?array $differences, array $diagnostics) {}

    public static function valid(array $differences): ComparisonResult {}

    public static function invalid(array $diagnostics): ComparisonResult {}
}

/** The outcome of Dbspec::exportMermaid: the erDiagram text and what export leaves out. */
final readonly class MermaidExportResult
{
    public string $text;
    public array $dropped;

    public function __construct(string $text, array $dropped) {}
}

/** The outcome of Dbspec::importMermaid: a document and what import leaves out, or the `mermaid` diagnostic and no document. */
final readonly class MermaidImportResult
{
    public ?Document $document;
    public array $dropped;
    public array $diagnostics;

    private function __construct(?Document $document, array $dropped, array $diagnostics) {}

    public static function valid(Document $document, array $dropped): MermaidImportResult {}

    public static function invalid(array $diagnostics): MermaidImportResult {}
}

/** The outcome of Dbspec::introspect: the document read from the database and the objects it leaves out. */
final readonly class IntrospectResult
{
    public Document $document;
    public array $unsupported;

    public function __construct(Document $document, array $unsupported) {}
}

/** Parses, validates and canonically emits dbspec documents (docs/dbspec.md). */
final class Dbspec
{
    /** The first bytes of every dbspec document file; the header `dbspec 1 <document>` starts with them. */
    public const string SIGNATURE = 'dbspec ';

    /**
     * Parses and validates the text; $documents maps each other document name of the declared set to its text.
     */
    public static function parse(string $text, array $documents): ParseResult {}

    /** Reads a dbspec document file and checks its bytes with readBytes, the path naming the file. */
    public static function readFile(string $path): ReadResult {}

    /** Checks the bytes of a document file that the caller read; $name is the name its messages use. */
    public static function readBytes(string $name, string $bytes): ReadResult {}

    /** Writes a document in its canonical text: `emit(parse(s)) === s` for canonical input. */
    public static function emit(Document $document): string {}

    /**
     * The statements that create the tables of the document set in `mysql`, `postgres` or `sqlite`, or the
     * diagnostics of the set. An unknown dialect is an InvalidArgumentException.
     */
    public static function render(array $documents, string $dialect): RenderResult {}

    /**
     * Reads the current database (MySQL), the current schema (PostgreSQL) or the main database (SQLite) of the
     * connection into one document named `$name` and the objects it leaves out. A failing query, or a catalog
     * that yields no document, is a RuntimeException; an unknown dialect is an InvalidArgumentException.
     */
    public static function introspect(\PDO $connection, string $dialect, string $name): IntrospectResult {}

    /** The manifest of the document set, whose documents are taken in document name order, or its diagnostics. */
    public static function manifest(array $documents): ManifestResult {}

    /** The differences between the tables that the set uses from external documents and the introspected database. */
    public static function externalDifferences(Document $live, array $documents): array {}

    /** Reads a plan document: a plan and no diagnostics, or one diagnostic located in the plan. */
    public static function parsePlan(string $text): PlanParseResult {}

    /** Writes a plan in its canonical text: `emitPlan(parsePlan(s)) === s` for canonical input. */
    public static function emitPlan(Plan $plan): string {}

    /** The plans in chain order from the empty database, or the `chain` diagnostics that name the plans. */
    public static function chain(array $plans): ChainResult {}

    /** The changes from the source schema, null for the empty database, to the plan's target, or the `plan` diagnostics. */
    public static function diff(?Document $source, Plan $plan): DiffResult {}

    /** Every difference from the source schema text to the target schema text, or the `compare` diagnostics. */
    public static function compareSchemas(Document $source, Document $target): ComparisonResult {}

    /** The differences between the database and the schema text of a document set; none means it is installed. */
    public static function installedDifferences(Document $live, array $unsupported, Document $target): array {}

    /** The added tables and columns, the plan steps that add them and the differences that prevent them. */
    public static function addTablesAndColumnsSteps(Document $live, array $unsupported, Document $target, string $dialect): array {}

    /** The steps of the plan from the source schema in `mysql`, `postgres` or `sqlite`, or the diff's diagnostics. */
    public static function planSteps(?Document $source, Plan $plan, string $dialect): PlanStepsResult {}

    /**
     * Applies the plans of the chain that the database has not recorded, one statement at a time, each plan up to
     * its finalize steps, verifying the schema after each plan. A failure is an ApplyError, or an
     * ApplyCleanupError when restoring the session after it fails too; an unknown dialect, or a connection whose
     * error mode is not PDO::ERRMODE_EXCEPTION, is an InvalidArgumentException.
     */
    public static function apply(\PDO $connection, string $dialect, array $plans, \Closure $now, ?\Closure $events): void {}

    /** Continues the interrupted plan forward. Failures and arguments are as for apply. */
    public static function recover(\PDO $connection, string $dialect, array $plans, \Closure $now, ?\Closure $events): void {}

    /** Undoes the last plan of the history with its rollback statements and deletes its row. Failures and arguments are as for apply. */
    public static function rollback(\PDO $connection, string $dialect, array $plans, \Closure $now, ?\Closure $events): void {}

    /** Runs the finalize steps of every applied plan in chain order and records the plans done. Failures and arguments are as for apply. */
    public static function finalize(\PDO $connection, string $dialect, array $plans, \Closure $now, ?\Closure $events): void {}

    /** Writes the document as a standard Mermaid erDiagram and lists what the diagram leaves out. */
    public static function exportMermaid(Document $document): MermaidExportResult {}

    /** Reads a standard Mermaid erDiagram into a document named `$name`, or the `mermaid` diagnostic of a line outside the grammar. */
    public static function importMermaid(string $text, string $name): MermaidImportResult {}
}

/**
 * The effect queries of apply and a test entry that reads one effect, as in the PHP client's PlanApply.
 *
 * @internal
 */
final class PlanApply
{
    public const array EFFECT_QUERIES = ['mysql' => ['table' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', 'column' => 'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', 'index' => 'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', 'constraint' => 'SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', 'trigger' => 'SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?'], 'postgres' => ['table' => 'SELECT COUNT(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN (\'r\', \'p\') AND relname = ?', 'column' => 'SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND a.attname = ? AND a.attnum > 0 AND NOT a.attisdropped', 'index' => 'SELECT COUNT(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND i.relname = ?', 'constraint' => 'SELECT COUNT(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND k.conname = ?', 'trigger' => 'SELECT COUNT(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND g.tgname = ? AND NOT g.tgisinternal', 'function' => 'SELECT COUNT(*) FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname = ?'], 'sqlite' => ['table' => 'SELECT COUNT(*) FROM sqlite_master WHERE type = \'table\' AND name = ?', 'column' => 'SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?', 'index' => 'SELECT COUNT(*) FROM sqlite_master WHERE type = \'index\' AND tbl_name = ? AND name = ?', 'trigger' => 'SELECT COUNT(*) FROM sqlite_master WHERE type = \'trigger\' AND tbl_name = ? AND name = ?', 'sequence' => 'SELECT COUNT(*) FROM sqlite_sequence WHERE name = ?']];

    private function __construct() {}

    /** Reads whether one effect holds in the database of the connection. */
    public static function effectOn(\PDO $c, string $dialect, Effect $e): bool {}
}
