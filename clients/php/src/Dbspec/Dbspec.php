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
     * The statements of the plan from the source schema, null for the empty
     * database, in one dialect, `mysql`, `postgres` or `sqlite`, or the diff's
     * diagnostics (docs/plans.md "Statements"). An unknown dialect is an
     * InvalidArgumentException.
     */
    public static function planStatements(?Document $source, Plan $plan, string $dialect): PlanStatementsResult
    {
        $renderer = new Renderer($dialect);
        [$diff, $diagnostics] = PlanDiff::of($source, $plan);
        return $diff === null ? PlanStatementsResult::invalid($diagnostics) : PlanStatementsResult::valid(PlanStatements::write($diff, $renderer));
    }
}
