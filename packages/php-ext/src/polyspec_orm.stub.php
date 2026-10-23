<?php

/**
 * @generate-class-entries
 */

/*
 * The one stub of the PHP extension polyspec_orm: the declarations of the classes it registers. Not loaded at runtime: if the
 * extension is present, it registers the class of the same name. The declarations are the inventory of the interface check
 * (contracts/interfaces.json's php-extension); make php-ext-arginfo writes src/polyspec_orm_arginfo.h from this file with
 * gen_stub.php, and make lint-php-ext checks that the header records this file's hash. packages/php-ext/tests/DeclarationsTest.php
 * checks that the Reflection of the loaded extension is the same as this file's Reflection.
 * The classes, their properties and methods are the same as the same-named classes of the PHP client (packages/php/src/Dbspec).
 * gen_stub cannot write array constants, so this file declares none: src/polyspec_orm.c registers ColumnType::SIMPLE,
 * ColumnType::PARAMETERIZED, ForeignKey::ACTIONS, Setting::KINDS, Setting::CODEC_STAGES, Setting::STORE_ARGUMENTS and
 * PlanApply::EFFECT_QUERIES, which DeclarationsTest compares with the PHP client. The return type uses the class name instead of `self`.
 * The classes have the names of the PHP client: the namespace Polyspec\Orm\Dbspec, then Polyspec\Orm, which holds Code, the block
 * that orm-gen errors writes.
 */

namespace Polyspec\Orm\Dbspec;

/** One SCHEMA_INVALID finding: the rule, the 1-based line and column of the offending token, and a message. */
final readonly class Diagnostic
{
    public string $rule;
    public int $line;
    public int $column;
    public string $message;

    public function __construct(string $rule, int $line, int $column, string $message) {}
}

/** One declaration of a parsed document: its kind, its path of enclosing names and its own name, and its line and column (docs/spec/dbspec.md "Declaration positions"). */
final readonly class Position
{
    public string $kind;
    public array $path;
    public int $line;
    public int $column;

    /** @param array $path */
    public function __construct(string $kind, array $path, int $line, int $column) {}
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

/**
 * One setting line; `audit` holds the history table, the audit column, the audit record table, the action and previous columns;
 * `store` holds its kind, its foreign key and shape (STORE_ARGUMENTS counts them), then the column and period of its shard clause.
 */
final class Setting
{
    public string $kind;
    public array $arguments;
    public array $comments;
    public ?array $exclude;
    public ?array $include;
    public ?string $form;
    public ?array $requires;

    public function __construct(string $kind, array $arguments, array $comments = [], ?array $exclude = null, ?array $include = null, ?string $form = null, ?array $requires = null) {}

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

/** One file of a read set (Dbspec::readSet): its joined path and its bytes, not yet checked. */
final readonly class SetFile
{
    public string $path;
    public string $bytes;

    public function __construct(string $path, string $bytes) {}
}

/** One error of Dbspec::readSet: its `set.*` rule, the path it concerns (the set file's path, or the joined path of an entry) and a message that names the path. */
final readonly class SetError
{
    public string $rule;
    public string $path;
    public string $message;

    public function __construct(string $rule, string $path, string $message) {}
}

/** The outcome of Dbspec::readSet: the files of `documents` and of `external` in written order and no errors, or the errors by step, then by path, and no files. */
final readonly class SetResult
{
    public ?array $documents;
    public ?array $external;
    public array $errors;

    private function __construct(?array $documents, ?array $external, array $errors) {}

    public static function valid(array $documents, array $external): SetResult {}

    public static function invalid(array $errors): SetResult {}
}

/** The result of one text of a set (Dbspec::parseSet): the name its header names, '' when the header fails; whether the text is external; and what one parse of the text returns. A text whose name an earlier text has is not parsed and carries the one diagnostic `name.duplicate`. */
final readonly class SetDocument
{
    public string $name;
    public bool $external;
    public ?Document $document;
    public ?array $positions;
    public array $diagnostics;

    public function __construct(string $name, bool $external, ?Document $document, ?array $positions, array $diagnostics) {}
}

/** The outcome of Dbspec::parse: a document, its declaration positions and no diagnostics, or every diagnostic in source order and no document and no positions. */
final readonly class ParseResult
{
    public ?Document $document;
    public array $diagnostics;
    public ?array $positions;

    private function __construct(?Document $document, array $diagnostics, ?array $positions) {}

    public static function valid(Document $document, array $positions): ParseResult {}

    public static function invalid(array $diagnostics): ParseResult {}
}

/** One token of a dbspec text: its 1-based line, its start and end in code points on the line, and its class (docs/spec/dbspec.md "Syntax analysis"). */
final readonly class Token
{
    public int $line;
    public int $start;
    public int $end;
    public string $class;

    public function __construct(int $line, int $start, int $end, string $class) {}
}

/** The outcome of Dbspec::analyze: the parse result unchanged, and the tokens of the text in source order. */
final readonly class Analysis
{
    public ?Document $document;
    public ?array $positions;
    public array $diagnostics;
    public array $tokens;

    /** The document and positions are null when the parse has a diagnostic; the lists hold Diagnostic and Token objects. */
    public function __construct(?Document $document, ?array $positions, array $diagnostics, array $tokens) {}
}

/** The outcome of Dbspec::format: the canonical text when the text has no diagnostic, else null with every diagnostic. */
final readonly class FormatResult
{
    public ?string $text;
    public array $diagnostics;

    /** The diagnostics are Diagnostic objects. */
    public function __construct(?string $text, array $diagnostics) {}
}

/** The renderer names that the renderer writes for a table and a suffix, and the column whose name they are (docs/spec/dbspec.md "Names"). */
final class Names
{
    public static function render(string $table, string $suffix): string {}

    public static function ofTable(Table $table): array {}

    public static function column(string $table, string $name, \Traversable|array $columns): ?string {}
}

/** The manifest and schema texts of a document set and their hashes (docs/spec/dbspec.md, "Manifest and hashes"). */
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

/** One step of a plan (docs/spec/plans.md "Steps"). */
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

/** How a step's statement shows that it took effect (docs/spec/plans.md "Steps", effects). */
final readonly class Effect
{
    public string $kind;
    public string $table;
    public string $name;
    public bool $present;

    public function __construct(string $kind, string $table, string $name, bool $present) {}

    public static function repeat(): Effect {}

    /** The text form of docs/spec/plans.md "Effects", such as `present table users`. */
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

/** One change of a plan's diff (docs/spec/plans.md "Diff"). */
final readonly class Change
{
    public string $kind;
    public string $table;
    public string $name;

    public function __construct(string $kind, string $table, string $name) {}
}

/** One difference of two schemas (docs/spec/plans.md "Comparison"). */
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

/** One occurrence of apply, recover, rollback or finalize (docs/spec/plans.md "Apply"). */
final readonly class ApplyEvent
{
    public string $kind;
    public string $plan;
    public int $step;
    public int $steps;
    public string $statement;

    public function __construct(string $kind, string $plan, int $step, int $steps, string $statement) {}
}

/** A failure of apply or recover (docs/spec/plans.md "Apply"). */
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

/** Parses, validates and canonically emits dbspec documents (docs/spec/dbspec.md). */
final class Dbspec
{
    /** The first bytes of every dbspec document file; the header `dbspec 1 <document>` starts with them. */
    public const string SIGNATURE = 'dbspec ';

    /**
     * Parses and validates the text; $documents maps each other document name of the declared set to its text.
     */
    public static function parse(string $text, array $documents): ParseResult {}

    /** Parses like parse and returns that result unchanged, with the tokens of the text (docs/spec/dbspec.md "Syntax analysis"). */
    public static function analyze(string $text, array $documents): Analysis {}

    /** The canonical text of the document when the text has no diagnostic; else every diagnostic and no text (docs/spec/dbspec.md "Formatting"). */
    public static function format(string $text, array $documents): FormatResult {}

    /** Reads a dbspec document file and checks its bytes with readBytes, the path naming the file. */
    public static function readFile(string $path): ReadResult {}

    /** Checks the bytes of a document file that the caller read; $name is the name its messages use. */
    public static function readBytes(string $name, string $bytes): ReadResult {}

    /** Reads the set file at $path and the files it lists (docs/spec/dbspec.md "Document sets"): the set file, its JSON, each path and the read with the file identity, in that order. */
    public static function readSet(string $path): SetResult {}

    /** Parses the texts of one document set (docs/spec/dbspec.md "Parsing a set"): one result per text, owned, then external, each in set order; a text whose header name an earlier text has is not parsed and carries `name.duplicate`. */
    public static function parseSet(array $owned, array $external): array {}

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
 * The effect queries of apply, the apply commands that Dbspec's take the place of, and a test entry that reads one effect, as in the
 * PHP client's PlanApply.
 *
 * @internal
 */
final class PlanApply
{
    private function __construct() {}

    /** Dbspec::apply, which calls it. */
    public static function apply(\PDO $c, string $dialect, array $plans, \Closure $now, ?\Closure $events): void {}

    /** Dbspec::recover. */
    public static function recover(\PDO $c, string $dialect, array $plans, \Closure $now, ?\Closure $events): void {}

    /** Dbspec::rollback. */
    public static function rollback(\PDO $c, string $dialect, array $plans, \Closure $now, ?\Closure $events): void {}

    /** Dbspec::finalize. */
    public static function finalize(\PDO $c, string $dialect, array $plans, \Closure $now, ?\Closure $events): void {}

    /** Reads whether one effect holds in the database of the connection. */
    public static function effectOn(\PDO $c, string $dialect, Effect $e): bool {}
}

// Code generated by orm-gen errors from docs/spec/errors.yaml; DO NOT EDIT.

namespace Polyspec\Orm;

/** Error codes shared by the engine and every executor (docs/spec/errors.yaml). */
final class Code
{
    /** engine: ir_version the engine does not speak */
    public const string VERSION_MISMATCH = 'VERSION_MISMATCH';
    /** engine: client generated from another dbspec document set than the engine loaded */
    public const string SCHEMA_HASH_MISMATCH = 'SCHEMA_HASH_MISMATCH';
    /** engine: the dbspec document set failed validation at load */
    public const string SCHEMA_INVALID = 'SCHEMA_INVALID';
    /** engine */
    public const string DIALECT_UNKNOWN = 'DIALECT_UNKNOWN';
    /** engine: structural: missing fields, wrong combination, param index out of range */
    public const string IR_INVALID = 'IR_INVALID';
    /** engine: requested operation is not supported by the selected dialect */
    public const string CAPABILITY_UNSUPPORTED = 'CAPABILITY_UNSUPPORTED';
    /** engine */
    public const string ENTITY_UNKNOWN = 'ENTITY_UNKNOWN';
    /** engine */
    public const string COLUMN_UNKNOWN = 'COLUMN_UNKNOWN';
    /** engine */
    public const string RELATION_UNKNOWN = 'RELATION_UNKNOWN';
    /** engine: force_index name not declared */
    public const string INDEX_UNKNOWN = 'INDEX_UNKNOWN';
    /** engine: select<Col>As name collides with a column */
    public const string COLUMN_ALIAS_CONFLICT = 'COLUMN_ALIAS_CONFLICT';
    /** engine */
    public const string OPERATOR_UNKNOWN = 'OPERATOR_UNKNOWN';
    /** engine: ORM function name outside the column or value function catalog */
    public const string FUNCTION_UNKNOWN = 'FUNCTION_UNKNOWN';
    /** engine: op not valid for the column's type/style (ir.OpAllowed) */
    public const string OPERATOR_NOT_ALLOWED = 'OPERATOR_NOT_ALLOWED';
    /** engine: or() as the first item of a group */
    public const string OR_AT_GROUP_START = 'OR_AT_GROUP_START';
    /** engine: in()/notIn() with no values */
    public const string EMPTY_IN = 'EMPTY_IN';
    /** engine: joined placement or column reference to a join missing from this statement */
    public const string ENTITY_NOT_JOINED = 'ENTITY_NOT_JOINED';
    /** engine: limit() on a relation child (use limitPerParent) */
    public const string LIMIT_IN_RELATION = 'LIMIT_IN_RELATION';
    /** executor: strict one-row query matched no row */
    public const string NO_ROWS = 'NO_ROWS';
    /** executor: restoreOrCreate found its key on a row that is not deleted; nothing was written */
    public const string ROW_NOT_DELETED = 'ROW_NOT_DELETED';
    /** executor: a batch of creates binds more parameters than the dialect allows; names the batch, its bind count and the limit; nothing was written */
    public const string BATCH_TOO_LARGE = 'BATCH_TOO_LARGE';
    /** executor: an update or delete given an expected revision found the row at another revision, or no row; nothing was written */
    public const string REVISION_CHANGED = 'REVISION_CHANGED';
    /** executor: a requested column was not included in the loaded row */
    public const string COLUMN_UNSELECTED = 'COLUMN_UNSELECTED';
    /** executor: updateOptimistic matched no row (updated_ts changed) */
    public const string OPTIMISTIC_LOCK = 'OPTIMISTIC_LOCK';
    /** executor: a target changed since it was read, or a change since the read makes the transaction's writes other writes; names the file and line; the client never retries it */
    public const string WRITE_CONFLICT = 'WRITE_CONFLICT';
    /** executor: styled column bytes could not be decoded (docs/spec/codec.md) */
    public const string CODEC_DECODE = 'CODEC_DECODE';
    /** executor: a parameter outside its slot's logical type, before any statement (kind, range, scale and precision, time precision, length, U+0000, uuid form), or a styled input that cannot be encoded, including SQL NULL for a non-null column (a NULL parameter assigned to a non-null column; raw SQL keeps DRIVER) */
    public const string CODEC_ENCODE = 'CODEC_ENCODE';
    /** executor: PHP objects/references in serialize, unknown style */
    public const string CODEC_UNSUPPORTED = 'CODEC_UNSUPPORTED';
    /** executor: missing secret, bad DSN/paths, transaction misuse */
    public const string CONFIG = 'CONFIG';
    /** executor: the statement stopped before it finished: its context or abort signal was cancelled, or a timeout bound expired (statement timeout, transaction timeoutMs, SQLite busy_timeout); a lock wait of the markdown executor that ends is CANCELED too, and so is a MySQL lock wait timeout (1205, innodb_lock_wait_timeout), and so is a MySQL lock wait timeout (1205, innodb_lock_wait_timeout) */
    public const string CANCELED = 'CANCELED';
    /** executor: a transaction or savepoint callback failed and its rollback failed too; the error keeps both errors */
    public const string ROLLBACK = 'ROLLBACK';
    /** executor: a test fault armed through the test entry point of the client reported the rollback of a transaction as failed after the rollback ran */
    public const string FAULT = 'FAULT';
    /** executor: a statement event subscriber of the connection failed; the operation fails with its error as the cause */
    public const string SUBSCRIBER = 'SUBSCRIBER';
    /** executor: addTablesAndColumns found a difference between the existing tables of a document set and the set other than a missing table, a missing column that is null or has a default or a missing index; a missing unique key is one, because it can fail on the existing rows */
    public const string SCHEMA_DIFFERS = 'SCHEMA_DIFFERS';
    /** executor */
    public const string INTERNAL = 'INTERNAL';
    /** executor */
    public const string QUERY_READ_ONLY = 'QUERY_READ_ONLY';
    /** executor */
    public const string QUERY_LIMIT_INVALID = 'QUERY_LIMIT_INVALID';
    /** executor */
    public const string CATALOG_LIMIT = 'CATALOG_LIMIT';
    /** executor */
    public const string CATALOG_VALUE = 'CATALOG_VALUE';
    /** executor */
    public const string CATALOG_PARAM = 'CATALOG_PARAM';
    /** executor: an operation on a catalog connection after its close(): nothing runs and no statement is sent */
    public const string CATALOG_CLOSED = 'CATALOG_CLOSED';
    /** executor */
    public const string TABLE_METADATA_INVALID = 'TABLE_METADATA_INVALID';
    /** executor */
    public const string TABLE_REFERENCE_INVALID = 'TABLE_REFERENCE_INVALID';
    /** executor */
    public const string TABLE_NOT_FOUND = 'TABLE_NOT_FOUND';
    /** executor */
    public const string TABLE_KIND_UNSUPPORTED = 'TABLE_KIND_UNSUPPORTED';
    /** executor: a native bind of the Rust catalog tool is unsupported or invalid (a malformed decimal, a nonfinite MySQL float, a SQLite NaN, PostgreSQL text with NUL) and is refused before execution */
    public const string TOOL_BIND_INVALID = 'TOOL_BIND_INVALID';
    /** executor: a native bind of the Rust catalog tool exceeds its budget (more than 65535 parameters, or total value bytes beyond 16 MiB), refused before preparing or executing */
    public const string TOOL_BIND_LIMIT = 'TOOL_BIND_LIMIT';
    /** executor: a query result of the Rust catalog tool exceeds its column metadata budget (more than 2048 columns, or the column names and native types together beyond 64 KiB) */
    public const string TOOL_QUERY_COLUMNS = 'TOOL_QUERY_COLUMNS';
    /** executor: a bounded query of the Rust catalog tool does not split into exactly one statement */
    public const string TOOL_QUERY_STATEMENT = 'TOOL_QUERY_STATEMENT';
    /** executor */
    public const string TABLE_NAMESPACE_UNSUPPORTED = 'TABLE_NAMESPACE_UNSUPPORTED';
    /** executor */
    public const string TABLE_NAMESPACE_UNAVAILABLE = 'TABLE_NAMESPACE_UNAVAILABLE';
    /** executor */
    public const string TABLE_PAGE_INVALID = 'TABLE_PAGE_INVALID';
    /** executor */
    public const string TABLE_PAGE_UNSUPPORTED = 'TABLE_PAGE_UNSUPPORTED';
    /** executor */
    public const string TABLE_PAGE_METADATA_CHANGED = 'TABLE_PAGE_METADATA_CHANGED';
    /** executor */
    public const string ROW_SNAPSHOT_INVALID = 'ROW_SNAPSHOT_INVALID';
    /** executor */
    public const string ROW_SNAPSHOT_LIMIT = 'ROW_SNAPSHOT_LIMIT';
    /** executor */
    public const string ROW_INSERT_INVALID = 'ROW_INSERT_INVALID';
    /** executor */
    public const string ROW_UPDATE_INVALID = 'ROW_UPDATE_INVALID';
    /** executor */
    public const string ROW_UPDATE_LIMIT = 'ROW_UPDATE_LIMIT';
    /** executor */
    public const string ROW_CONFLICT = 'ROW_CONFLICT';
    /** executor */
    public const string ROW_IDENTITY_AMBIGUOUS = 'ROW_IDENTITY_AMBIGUOUS';
    /** executor */
    public const string ROW_SCHEMA_CHANGED = 'ROW_SCHEMA_CHANGED';
    /** executor */
    public const string ROW_WRITE_MISMATCH = 'ROW_WRITE_MISMATCH';
    /** executor */
    public const string ROW_MUTATION_UNSUPPORTED = 'ROW_MUTATION_UNSUPPORTED';
    /** executor */
    public const string ROW_COMMIT_REJECTED = 'ROW_COMMIT_REJECTED';
    /** executor */
    public const string ROW_COMMIT_INDETERMINATE = 'ROW_COMMIT_INDETERMINATE';
    /** executor */
    public const string ROW_ROLLBACK_FAILED = 'ROW_ROLLBACK_FAILED';
    /** executor */
    public const string GRID_TEMPORAL_VALUE = 'GRID_TEMPORAL_VALUE';
    /** executor */
    public const string GRID_TEMPORAL_PRECISION = 'GRID_TEMPORAL_PRECISION';
    /** driver: a NOWAIT lock could not be acquired immediately */
    public const string LOCK_NOT_AVAILABLE = 'LOCK_NOT_AVAILABLE';
    /** driver: MySQL 1213 / SQLSTATE 40001 / PostgreSQL 40P01 / SQLite LOCKED; retries require TransactionOptions */
    public const string DEADLOCK = 'DEADLOCK';
    /** driver: MySQL 1062 (SQLSTATE 23000), PostgreSQL 23505, SQLite 2067 and 1555 */
    public const string DUPLICATE_KEY = 'DUPLICATE_KEY';
    /** driver: MySQL 1451/1452 / PostgreSQL 23503 / SQLite 787, and SQLite 1811 "FOREIGN KEY constraint failed" of a RESTRICT action */
    public const string FOREIGN_KEY = 'FOREIGN_KEY';
    /** driver: MySQL 3819/4025 / PostgreSQL 23514 / SQLite 275 */
    public const string CONSTRAINT = 'CONSTRAINT';
    /** driver: a write rejected because the server or connection is read-only: MySQL 1290/1792 / PostgreSQL 25006 / SQLite 8 and its extended codes */
    public const string READ_ONLY = 'READ_ONLY';
    /** driver: the server ended the connection or the connection broke (a killed session, a restart, an idle limit): MySQL 2006/2013/4031 / PostgreSQL SQLSTATE class 08 and 57P01/57P02/57P05, or a client library error on a connection that is no longer open; SQLite has no server connection */
    public const string CONNECTION_LOST = 'CONNECTION_LOST';
    /** driver: any other driver error, such as a write that a trigger refuses: MySQL 1644 / PostgreSQL P0001 / SQLite 1811 of a trigger RAISE */
    public const string DRIVER = 'DRIVER';
}
// End of the code generated by orm-gen errors.

namespace Polyspec\Orm;

/**
 * Column-style codecs (docs/spec/codec.md), the codec of the PHP library. The extension implements the codec in C (codec.c);
 * the methods the extension does not implement yet throw CODEC_UNSUPPORTED and name the item that implements them.
 */
final class Codec
{
    public static function blindIndex(mixed $v, string $key): ?string {}
    public static function decode(array $styles, mixed $raw): StyledValue {}
    public static function encode(array $styles, StyledValue $v): string|Bytes|null {}
    public static function isHostStyle(string $style): bool {}
    public static function hostEncode(mixed $v, array $styles, string $aesKey): string|Bytes|null {}
    public static function hostDecode(mixed $raw, array $styles, string $aesKey): ?string {}
    public static function decodeRows(array &$rows, array $cells, Config $config): void {}
}

/**
 * The request validator (docs/spec/protocol.md), the Validator of the PHP library. The extension implements it in C (validator.c); its
 * checks and error codes are those of packages/php/src/Validator.php. The members of the class are the PHP client's public members,
 * and its two private members are the model and n_params of the validation in progress.
 */
final class Validator
{
    public const int IR_VERSION = 1;
    private RuntimeModel $m;
    private int $n = 0;
    public function __construct(RuntimeModel $m) {}
    public static function opAllowed(array $c, string $op): bool {}
    public function validate(array $r): void {}
    public static function restoreKey(array $ent, array $r): array {}
    public function paramUses(array $r): array {}
    public static function functionType(string $name, ?array $col): string {}
    public static function intervalType(string $name): string {}
    public static function conflictKey(array $ent, array $set): array {}
}

/**
 * The request planner (docs/spec/protocol.md), the Planner of the PHP library. The extension implements it in C (planner.c); its
 * statements, bind slots and errors are those of packages/php/src/Planner.php.
 */
final class Planner
{
    private readonly RuntimeModel $m;
    private readonly Dialect $d;
    public function __construct(RuntimeModel $m, Dialect $d) {}
    /** @return array{manifest_hash: string, kind: string, steps: list<array>} */
    public function compile(array $r): array {}
}

/**
 * A database connection of the PHP library (packages/php/src/Db.php). The extension implements the connection, the statement path,
 * the transaction, savepoint, audit and execute methods, and utils() and stats(), in C (db.c). DRIVERS is registered by
 * src/polyspec_orm.c, since the stub declares no array constants.
 */
final class Db
{
    public const string SECRET = '$SECRET';
    public const string NOW = '$NOW';
    private readonly DbState $state;
    private array $masks;
    private bool $typed;
    private ?\Closure $requestHook;
    private readonly string $driver;
    private readonly Config $config;
    private readonly \DateTimeZone $zone;
    private readonly ?MarkdownSession $md;

    /** @internal Orm::connect creates connections. */
    public function __construct(?\PDO $pdo, string $driver, Config $config, \DateTimeZone $zone, ?MarkdownSession $md = null) {}
    /** @internal */
    public function registerSet(Schema $schema): void {}
    public function driver(): string {}
    /** @internal */
    public function markdownSession(): MarkdownSession {}
    /** @internal */
    public function unsupportedOnMarkdown(string $surface): void {}
    /** @internal */
    public function registeredModel(string $hash): RuntimeModel {}
    /** @internal */
    public function zone(): \DateTimeZone {}
    /** @internal */
    public function config(): Config {}
    /** @internal */
    public function pdo(): \PDO {}
    /** @internal */
    public function driverError(\PDOException $e): OrmException {}
    /** The operations outside the query syntax. */
    public function utils(): Utils {}
    /** The connection state: one connection per Db in PHP. */
    public function stats(): Stats {}
    public function close(): void {}
    public function withRequestHook(\Closure $hook): Db {}
    public function subscribe(\Closure $subscriber): \Closure {}
    /** @internal */
    public function setListener(\Closure $open): void {}
    /** @internal */
    public function listener(): ?\Closure {}
    public function notify(string $channel, string $payload): void {}
    public function listen(string $channel): Subscription {}
    /** @internal */
    public function nextTransaction(): int {}
    /** @internal */
    public function transactionNumber(): ?int {}
    /** @internal */
    public function publish(string $kind, array $tables, ?int $transaction, string $sql, array $binds, int $start, ?OrmException $error): void {}
    /** @internal */
    public function observed(string $kind, array $tables, ?int $transaction, string $sql, array $binds, \Closure $send): mixed {}
    /** @internal */
    public function run(string $kind, array $tables, ?int $transaction, string $sql, bool $control = false): void {}
    /** @internal */
    public function fetch(string $kind, array $tables, ?int $transaction, string $sql, array $args = [], bool $control = false): array {}
    public static function bindLimit(string $driver): int {}
    public static function insertParts(int $rows, int $batch): array {}
    /** @internal */
    public static function activeFor(Db $db): ?TxFrame {}
    /** @internal */
    public static function resolve(?Db $conn): array {}
    /** @internal */
    public static function inTransaction(?Db $conn, \Closure $fn): void {}
    public function transaction(\Closure $fn, string $isolation = '', bool $readOnly = false, int $timeoutMs = 0, int $retry = 3, ?array $audit = null): mixed {}
    /** @internal @return array{0: array, 1: array} */
    public function select(?TxFrame $frame, Request $r): array {}
    /** @internal */
    public function scalarOf(?TxFrame $frame, Request $r): mixed {}
    /** @internal @return array{0: array, 1: array, 2: int} */
    public function paginate(?TxFrame $frame, Request $r): array {}
    /** @internal @return array{0: int|float|string|null, 1: int} */
    public function writeOf(?TxFrame $frame, Request $r, ?\Closure $afterHook = null): array {}
    /** @internal */
    public function execute(array $step, array $params): void {}
    /** @internal @return array{sql: string, binds: list<mixed>} */
    public function statement(Request $r): array {}
    /** @internal */
    public function clock(): \DateTimeImmutable {}
    /** @internal */
    public static function timeValue(mixed $v, string $colType, int $precision, \DateTimeZone $zone): mixed {}
    /** @internal */
    public function acquireSQLiteRowLock(string $mode): void {}
    /** @internal */
    public static function rowKey(array $row, array $refs): int|string|bool|Bytes|\DateTimeInterface|null {}
    /** @internal */
    public static function rowSlot(array $row, array $refs): ?string {}
    /** @internal */
    public static function sameScalar(mixed $a, mixed $b): bool {}
    /** @internal */
    public static function scalarText(mixed $v): string {}
}

/** One statement that the connection sent to the database (docs/operations/usage.md "Statement events"). */
final readonly class StatementEvent
{
    public const string SELECT = 'select';
    public const string INSERT = 'insert';
    public const string UPDATE = 'update';
    public const string DELETE = 'delete';
    public const string BEGIN = 'begin';
    public const string COMMIT = 'commit';
    public const string ROLLBACK = 'rollback';
    public const string SAVEPOINT = 'savepoint';
    public const string RELEASE = 'release';
    public const string ROLLBACK_TO = 'rollback_to';
    public const string SCHEMA = 'schema';
    public const string UTILITY = 'utility';

    public string $sql;
    public array $binds;
    public string $kind;
    public array $tables;
    public float $elapsed;
    public ?int $transaction;
    public ?OrmException $error;

    public function __construct(string $sql, array $binds, string $kind, array $tables, float $elapsed, ?int $transaction, ?OrmException $error) {}
}

/**
 * An ordered set of models keyed by a typed key. The extension implements the collection in C.
 *
 * @template TModel
 * @implements \IteratorAggregate<int|string|bool|Bytes|\DateTimeInterface, TModel>
 */
final class Collection implements \IteratorAggregate, \Countable, \JsonSerializable
{
    /** @var array<string, array{0: int|string|bool|Bytes|\DateTimeInterface, 1: TModel}> */
    private array $items = [];
    /** @var array<string, mixed> */
    private array $fetched = [];

    public static function keyOf(mixed $key): int|string|bool|Bytes|\DateTimeInterface {}
    public static function identityOf(mixed $key): string {}
    public function put(int|string|bool|Bytes|\DateTimeInterface $key, Model $model): void {}
    public function get(int|string|bool|Bytes|\DateTimeInterface $key): ?Model {}
    public function has(int|string|bool|Bytes|\DateTimeInterface $key): bool {}
    public function first(): ?Model {}
    public function keys(): array {}
    public function all(): array {}
    public function entries(): array {}
    public function count(): int {}
    public function getIterator(): \Traversable {}
    public function fetchValues(\Closure $fn): void {}
    public function fetchedValue(int|string|bool|Bytes|\DateTimeInterface $key): mixed {}
    public function fetchedValues(): array {}
    public function connect(Db $db): Collection {}
    public function __invoke(Db $db): Collection {}
    public function delete(bool $recursive = false): void {}
    public function toArray(): array {}
    public function toJson(): string {}
    public function jsonSerialize(): array {}
}

/**
 * @internal
 */
final class CollectionIterator implements \Iterator
{
    public function current(): mixed {}
    public function key(): mixed {}
    public function next(): void {}
    public function rewind(): void {}
    public function valid(): bool {}
}

/**
 * @internal
 */
final class CollectionDeleteCallback
{
    public function __invoke(): void {}
}


/**
 * @internal
 */
final class Request
{
    public array $ir;
    /** @var list<mixed> */
    public array $params = [];
    /** @var array<string, bool> */
    public array $names = [];
    /** @var array<int, list<array>> */
    public array $external = [];
    public bool $canonical = false;

    public function __construct(string $kind, string $manifestHash) {}
    public function param(mixed $v): int {}
    public static function padIn(array $values): array {}
    public function canonicalize(): void {}
    public function shape(): array {}
}

/** A selected styled column value, including the SQL NULL state. */
final readonly class StyledValue implements \JsonSerializable
{
    public string $kind;
    private mixed $payload;

    private function __construct(string $kind, mixed $payload = null) {}
    public static function sqlNull(): StyledValue {}
    public static function value(mixed $value): StyledValue {}
    public function payload(): mixed {}
    public function jsonSerialize(): array {}
}

/** One page of rows. @template TModel of Model */
final readonly class Page
{
    /** @var Collection<TModel> */
    public Collection $items;
    public int $totalCount;
    public int $totalPages;
    public int $page;
    public int $perPage;

    /** @param Collection $items */
    public function __construct(Collection $items, int $totalCount, int $totalPages, int $page, int $perPage) {}
}

/** An ORM function expression passed to the native planner. */
final readonly class Func
{
    public string $name;
    /** @var list<int> */
    public array $args;
    public bool $column;

    /** @param array $args */
    public function __construct(string $name, array $args, bool $column) {}
    /** @param callable $param */
    public function ir(callable $param): array {}
}

/**
 * @internal
 */
final class PendingTime
{
    public readonly string $text;
    public readonly \DateTimeZone $zone;

    public function __construct(string $text, \DateTimeZone $zone) {}
}
