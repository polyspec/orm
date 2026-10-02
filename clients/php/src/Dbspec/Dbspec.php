<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** Parses, validates and canonically emits dbspec documents (docs/dbspec.md). */
final class Dbspec
{
    /**
     * Parses a document. `$documents` is the declared document set, document
     * name => text, in which `use` lines find the documents they name. The
     * result holds the document and no diagnostics, or every diagnostic in
     * source order and no document.
     *
     * @param array<string, string> $documents
     */
    public static function parse(string $text, array $documents): ParseResult
    {
        foreach ($documents as $name => $source) {
            if (!is_string($name) || !is_string($source)) {
                throw new \InvalidArgumentException('The declared document set maps document names to texts');
            }
        }
        [$document, $diagnostics] = (new Parser($documents))->run($text);
        return $document === null ? ParseResult::invalid($diagnostics) : ParseResult::valid($document);
    }

    /** 모든 dbspec document 파일의 첫 byte다. header `dbspec 1 <document>`가 이것으로 시작한다. */
    public const SIGNATURE = 'dbspec ';

    /**
     * parse할 $path의 dbspec document 파일을 읽는다(docs/dbspec.md "Files"). SIGNATURE로
     * 시작하지 않는 파일은 text 없이 line 1, column 1의 `signature` diagnostic 하나와 message
     * "<path> is not a dbspec document"를 돌려주며 parse하지 않는다. directory나 읽을 수
     * 없는 파일은 "cannot read <path>: <reason>" RuntimeException이다.
     */
    public static function readFile(string $path): ReadResult
    {
        // PHP는 directory를 열고 빈 text를 읽으므로, 빈 파일의 signature diagnostic이 되기 전에 거부한다.
        if (is_dir($path)) {
            throw new \RuntimeException("cannot read $path: is a directory");
        }
        $text = @file_get_contents($path);
        if ($text === false) {
            $reason = error_get_last()['message'] ?? 'cannot be read';
            throw new \RuntimeException("cannot read $path: $reason");
        }
        if (!str_starts_with($text, self::SIGNATURE)) {
            return ReadResult::invalid([new Diagnostic('signature', 1, 1, "$path is not a dbspec document")]);
        }
        return ReadResult::valid($text);
    }

    /** Writes a document in its canonical text: `emit(parse(s)) === s` for canonical input. */
    public static function emit(Document $document): string
    {
        return Emitter::emit($document, View::Canonical);
    }

    /**
     * The statements that create the tables of the document set in one
     * dialect, `mysql`, `postgres` or `sqlite` (docs/dialects.md "Rendered
     * statements"), or the diagnostics of the set (docs/dbspec.md "Manifest
     * and hashes"). An unknown dialect is an InvalidArgumentException.
     *
     * @param list<Document> $documents
     */
    public static function render(array $documents, string $dialect): RenderResult
    {
        if (!in_array($dialect, Renderer::DIALECTS, true)) {
            throw new \InvalidArgumentException("Unknown dialect `$dialect`; the dialects are mysql, postgres and sqlite");
        }
        [, $diagnostics] = DocumentSet::check($documents);
        return $diagnostics === [] ? RenderResult::valid(Renderer::render($documents, $dialect)) : RenderResult::invalid($diagnostics);
    }

    /**
     * Reads the current database (MySQL), the current schema (PostgreSQL) or
     * the main database (SQLite) of the connection into one document named
     * `$name` and the objects it leaves out (docs/dialects.md
     * "Introspection"). The number of catalog queries does not depend on the
     * table count. A failing query, or a catalog that yields no document, is
     * a RuntimeException; an unknown dialect is an InvalidArgumentException.
     */
    public static function introspect(\PDO $connection, string $dialect, string $name): IntrospectResult
    {
        $catalog = match ($dialect) {
            'mysql' => MysqlCatalog::read($connection),
            'postgres' => PostgresCatalog::read($connection),
            'sqlite' => SqliteCatalog::read($connection),
            default => throw new \InvalidArgumentException("Unknown dialect `$dialect`; the dialects are mysql, postgres and sqlite"),
        };
        return $catalog->document($name);
    }

    /**
     * The manifest of the document set, whose documents are taken in document
     * name order, or the diagnostics of the set (docs/dbspec.md "Manifest and
     * hashes").
     *
     * @param list<Document> $documents
     */
    public static function manifest(array $documents): ManifestResult
    {
        [$ordered, $diagnostics] = DocumentSet::check($documents);
        if ($diagnostics !== []) {
            return ManifestResult::invalid($diagnostics);
        }
        $manifestText = '';
        $tables = [];
        foreach ($ordered as $document) {
            $manifestText .= Emitter::emit($document, View::Manifest);
            array_push($tables, ...$document->tables);
        }
        // schema text 는 집합의 모든 table 을 이름 순으로 담은 문서 `schema` 하나이므로 문서를 나누는 방식과 무관하다.
        usort($tables, static fn(Table $a, Table $b): int => strcmp($a->name, $b->name));
        $schema = new Document('schema');
        $schema->tables = $tables;
        $schemaText = Emitter::emit($schema, View::Schema);
        return ManifestResult::valid(new Manifest($manifestText, $schemaText, 'sha256:' . hash('sha256', $manifestText), 'sha256:' . hash('sha256', $schemaText)));
    }

    /**
     * Reads a plan document (docs/plans.md "Plan document"): a plan and no
     * diagnostics, or one diagnostic located in the plan.
     */
    public static function parsePlan(string $text): PlanParseResult
    {
        return PlanText::parse($text);
    }

    /** Writes a plan in its canonical text: `emitPlan(parsePlan(s)) === s` for canonical input. */
    public static function emitPlan(Plan $plan): string
    {
        return PlanText::emit($plan);
    }

    /**
     * The plans in chain order from the empty database, or the `chain`
     * diagnostics that name the plans (docs/plans.md "Chain").
     *
     * @param list<Plan> $plans
     */
    public static function chain(array $plans): ChainResult
    {
        return PlanChain::chain($plans);
    }

    /**
     * The changes from the source schema, null for the empty database, to the
     * plan's target, or the `plan` diagnostics (docs/plans.md "Diff").
     */
    public static function diff(?Document $source, Plan $plan): DiffResult
    {
        [$diff, $diagnostics] = PlanDiff::of($source, $plan);
        return $diff === null ? DiffResult::invalid($diagnostics) : DiffResult::valid($diff->changes);
    }

    /**
     * plan 없이 source 에서 target 까지의 모든 차이, 또는 schema text 가 아닌 쪽의
     * `compare` diagnostic 이다(docs/plans.md "Comparison").
     */
    public static function compareSchemas(Document $source, Document $target): ComparisonResult
    {
        return SchemaComparison::compare($source, $target);
    }

    /**
     * The steps of the plan from the source schema, null for the empty
     * database, in one dialect, `mysql`, `postgres` or `sqlite`, each with its
     * statement, rollback statement or irreversible reason, effect, restore
     * statements, null checks and finalize mark, or the diff's diagnostics
     * (docs/plans.md "Steps"). An unknown dialect is an
     * InvalidArgumentException.
     */
    public static function planSteps(?Document $source, Plan $plan, string $dialect): PlanStepsResult
    {
        $renderer = new Renderer($dialect);
        [$diff, $diagnostics] = PlanDiff::of($source, $plan);
        return $diff === null ? PlanStepsResult::invalid($diagnostics) : PlanStepsResult::valid(PlanSteps::write($diff, $renderer, $plan));
    }

    /**
     * Applies, step by step, the plans of the chain that the database of the
     * connection has not applied, up to their finalize steps (docs/plans.md
     * "Apply"): it takes the lock, keeps the history table `dbspec$plans`,
     * checks the state, reports the steps without rollback, runs and records
     * each statement and verifies each plan. `$now` gives the time recorded
     * as `applied_at`; `$events` receives each ApplyEvent, and an exception it
     * throws stops apply there. A failure propagates unchanged: an ApplyError
     * with its code, the PDOException of a history, lock or setting
     * statement, a RuntimeException for an advisory unlock that released
     * nothing or a query without a row or whose result cannot be closed, or
     * the exception of `$events`. When restoring the session settings or
     * SQLite foreign keys, releasing the lock or closing a result fails after
     * it, apply throws an ApplyCleanupError whose previous throwable is that
     * failure and whose `cleanup` lists the cleanup errors in order. An
     * unknown dialect, or a connection whose error mode is not
     * PDO::ERRMODE_EXCEPTION, is an InvalidArgumentException. A database that
     * has applied the whole chain stays unchanged.
     *
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function apply(\PDO $connection, string $dialect, array $plans, \Closure $now, ?\Closure $events): void
    {
        PlanApply::apply($connection, $dialect, $plans, $now, $events);
    }

    /**
     * Continues the interrupted plan forward: it reads in the catalog whether
     * the statement after the recorded step took effect and runs the rest,
     * up to `applied`, or to `done` for a finalizing plan (docs/plans.md
     * "Apply"). Without an interrupted plan nothing changes. Failures and
     * arguments are as for apply.
     *
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function recover(\PDO $connection, string $dialect, array $plans, \Closure $now, ?\Closure $events): void
    {
        PlanApply::recover($connection, $dialect, $plans, $now, $events);
    }

    /**
     * Undoes the last plan of the history with its rollback statements, down
     * to its first step, and deletes its row (docs/plans.md "Apply"). An
     * applied plan is checked for drift and NULL rows first; a step without
     * rollback stops it with an `irreversible` ApplyError. Without a row
     * nothing changes. Failures and arguments are as for apply.
     *
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function rollback(\PDO $connection, string $dialect, array $plans, \Closure $now, ?\Closure $events): void
    {
        PlanApply::rollback($connection, $dialect, $plans, $now, $events);
    }

    /**
     * Runs the finalize steps of every applied plan in chain order, dropping
     * the hidden tables and columns, and records the plans `done`
     * (docs/plans.md "Apply"). Failures and arguments are as for apply.
     *
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function finalize(\PDO $connection, string $dialect, array $plans, \Closure $now, ?\Closure $events): void
    {
        PlanApply::finalize($connection, $dialect, $plans, $now, $events);
    }

    /**
     * Writes the document as a standard Mermaid erDiagram and lists what the
     * diagram leaves out, as Unsupported in table, kind and name order
     * (docs/mermaid.md "Export").
     */
    public static function exportMermaid(Document $document): MermaidExportResult
    {
        return Mermaid::export($document);
    }

    /**
     * Reads a standard Mermaid erDiagram into a document named `$name` and
     * lists what import leaves out (docs/mermaid.md "Import"), or the
     * `mermaid` diagnostic of a line that does not follow the grammar.
     */
    public static function importMermaid(string $text, string $name): MermaidImportResult
    {
        return Mermaid::import($text, $name);
    }
}
