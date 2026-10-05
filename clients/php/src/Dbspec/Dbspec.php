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
     * parse할 $path의 dbspec document 파일을 읽고 그 byte를 path를 이름으로 readBytes로
     * 확인한다(docs/dbspec.md "Files"). directory나 읽을 수 없는 파일은
     * "cannot read <path>: <reason>" RuntimeException이다.
     */
    public static function readFile(string $path): ReadResult
    {
        // PHP는 directory를 열고 빈 text를 읽으므로, 빈 파일의 signature diagnostic이 되기 전에 거부한다.
        if (is_dir($path)) {
            throw new \RuntimeException("cannot read $path: is a directory");
        }
        $bytes = @file_get_contents($path);
        if ($bytes === false) {
            $reason = error_get_last()['message'] ?? 'cannot be read';
            throw new \RuntimeException("cannot read $path: $reason");
        }
        return self::readBytes($path, $bytes);
    }

    /**
     * 호출자가 자기 규칙으로 읽은 dbspec document 파일의 byte를 parse 전에 확인한다.
     * $name은 message가 파일을 가리키는 이름이다. SIGNATURE로 시작하지 않는 byte는 text 없이
     * line 1, column 1의 `signature` diagnostic 하나와 message "<name> is not a dbspec
     * document"를, UTF-8이 아닌 byte는 첫 잘못된 byte의 줄과 칸에서 `encoding` diagnostic
     * 하나와 message "<name> is not valid UTF-8"을 돌려준다. 그 밖의 byte는 diagnostic 없이
     * 그대로 text가 된다.
     */
    public static function readBytes(string $name, string $bytes): ReadResult
    {
        if (!str_starts_with($bytes, self::SIGNATURE)) {
            return ReadResult::invalid([new Diagnostic('signature', 1, 1, "$name is not a dbspec document")]);
        }
        if (preg_match('//u', $bytes) !== 1) {
            [$line, $column] = self::invalidUtf8Position($bytes);
            return ReadResult::invalid([new Diagnostic('encoding', $line, $column, "$name is not valid UTF-8")]);
        }
        return ReadResult::valid($bytes);
    }

    /**
     * 첫 잘못된 UTF-8 byte의 줄과 칸(code point 단위)이다. 줄은 LF로 나눈다.
     *
     * @return array{int, int}
     */
    private static function invalidUtf8Position(string $bytes): array
    {
        $line = 1;
        $column = 1;
        $length = strlen($bytes);
        for ($i = 0; $i < $length;) {
            $size = self::utf8Size($bytes, $i, $length);
            if ($size === 0) {
                break;
            }
            if ($bytes[$i] === "\n") {
                $line++;
                $column = 1;
            } else {
                $column++;
            }
            $i += $size;
        }
        return [$line, $column];
    }

    /** $i에서 시작하는 올바른 UTF-8 문자의 byte 수, 잘못된 byte이면 0이다. */
    private static function utf8Size(string $bytes, int $i, int $length): int
    {
        $b = ord($bytes[$i]);
        [$size, $low, $high] = match (true) {
            $b < 0x80 => [1, 0, 0],
            $b >= 0xC2 && $b <= 0xDF => [2, 0x80, 0xBF],
            $b === 0xE0 => [3, 0xA0, 0xBF],
            $b === 0xED => [3, 0x80, 0x9F],
            $b >= 0xE1 && $b <= 0xEF => [3, 0x80, 0xBF],
            $b === 0xF0 => [4, 0x90, 0xBF],
            $b >= 0xF1 && $b <= 0xF3 => [4, 0x80, 0xBF],
            $b === 0xF4 => [4, 0x80, 0x8F],
            default => [0, 0, 0],
        };
        if ($size <= 1) {
            return $size;
        }
        if ($i + $size > $length) {
            return 0;
        }
        $second = ord($bytes[$i + 1]);
        if ($second < $low || $second > $high) {
            return 0;
        }
        for ($k = 2; $k < $size; $k++) {
            $next = ord($bytes[$i + $k]);
            if ($next < 0x80 || $next > 0xBF) {
                return 0;
            }
        }
        return $size;
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
        $used = [];
        foreach ($ordered as $document) {
            if ($document->external) {
                continue;
            }
            foreach ($document->uses as $use) {
                foreach ($use->tables as $table) {
                    if (!in_array($table, $used[$use->document] ?? [], true)) {
                        $used[$use->document][] = $table;
                    }
                }
            }
        }
        $manifestText = '';
        $externalText = '';
        $tables = [];
        $schema = new Document('schema');
        foreach ($ordered as $document) {
            if ($document->external) {
                $trimmed = self::externalDocument($document, $used[$document->name] ?? []);
                if ($trimmed !== null) {
                    $externalText .= Emitter::emit($trimmed, View::Manifest);
                    $names = $used[$document->name];
                    sort($names, SORT_STRING);
                    $schema->uses[] = new UseLine($document->name, $names);
                }
                continue;
            }
            $manifestText .= Emitter::emit($document, View::Manifest);
            array_push($tables, ...$document->tables);
        }
        // schema text 는 집합이 소유한 모든 table 을 이름 순으로 담은 문서 `schema` 하나이므로 문서를 나누는
        // 방식과 무관하다. 외부 문서에서 쓰는 table 은 그 문서의 use 줄로 남는다.
        usort($tables, static fn(Table $a, Table $b): int => strcmp($a->name, $b->name));
        $schema->tables = $tables;
        $schemaText = Emitter::emit($schema, View::Schema);
        return ManifestResult::valid(new Manifest($manifestText, $schemaText, 'sha256:' . hash('sha256', $manifestText . $externalText), 'sha256:' . hash('sha256', $schemaText), $externalText));
    }

    /**
     * 외부 문서에서 $tables의 column, primary key, unique key만 문서 순서로 담은 문서다. 그 table이
     * 없으면 null이다. foreign key, index, check, setting은 외부 문서가 소유하므로 담지 않는다.
     *
     * @param list<string> $tables
     */
    private static function externalDocument(Document $document, array $tables): ?Document
    {
        $out = new Document($document->name);
        foreach ($document->tables as $table) {
            if (!in_array($table->name, $tables, true)) {
                continue;
            }
            $trimmed = new Table($table->name);
            $trimmed->columns = $table->columns;
            $trimmed->primaryKey = $table->primaryKey === null ? null : new PrimaryKey($table->primaryKey->columns);
            $trimmed->uniqueKeys = array_map(static fn(UniqueKey $u): UniqueKey => new UniqueKey($u->name, $u->columns), $table->uniqueKeys);
            $out->tables[] = $trimmed;
        }
        return $out->tables === [] ? null : $out;
    }

    /**
     * set이 외부 문서에서 쓰는 table이 database에 있는지 확인한다(docs/dbspec.md "External
     * documents"). `$live`는 database를 introspect한 문서다. 쓰는 table마다 table이 없거나, 외부
     * 문서의 column이 없거나 type이나 null이 다르거나, primary key가 다르거나, unique key의 column
     * 목록이 없으면 그 차이를 table 이름, column 순으로 돌려준다. 외부 문서가 없으면 빈 목록이다.
     *
     * @param list<Document> $documents
     * @return list<string>
     */
    public static function externalDifferences(Document $live, array $documents): array
    {
        $external = [];
        foreach ($documents as $document) {
            if ($document->external) {
                $external[$document->name] = $document;
            }
        }
        $tables = [];
        foreach ($documents as $document) {
            if ($document->external) {
                continue;
            }
            foreach ($document->uses as $use) {
                $source = $external[$use->document] ?? null;
                if ($source === null) {
                    continue;
                }
                foreach ($use->tables as $name) {
                    foreach ($source->tables as $table) {
                        if ($table->name === $name && !isset($tables[$name])) {
                            $tables[$name] = $table;
                        }
                    }
                }
            }
        }
        ksort($tables, SORT_STRING);
        $liveTables = [];
        foreach ($live->tables as $table) {
            $liveTables[$table->name] = $table;
        }
        $nullText = static fn(bool $null): string => $null ? 'null' : 'not null';
        $out = [];
        foreach ($tables as $name => $want) {
            $got = $liveTables[$name] ?? null;
            if ($got === null) {
                $out[] = "table $name does not exist";
                continue;
            }
            $gotColumns = [];
            foreach ($got->columns as $column) {
                $gotColumns[$column->name] = $column;
            }
            foreach ($want->columns as $column) {
                $g = $gotColumns[$column->name] ?? null;
                if ($g === null) {
                    $out[] = "column $name.{$column->name} does not exist";
                } elseif ($g->type->text() !== $column->type->text()) {
                    $out[] = "column $name.{$column->name} is {$g->type->text()}, not {$column->type->text()}";
                } elseif ($g->nullable !== $column->nullable) {
                    $out[] = "column $name.{$column->name} is {$nullText($g->nullable)}, not {$nullText($column->nullable)}";
                }
            }
            $gotKey = $got->primaryKey?->columns ?? [];
            $wantKey = $want->primaryKey?->columns ?? [];
            if ($gotKey !== $wantKey) {
                $out[] = "table $name has the primary key (" . implode(', ', $gotKey) . '), not (' . implode(', ', $wantKey) . ')';
            }
            foreach ($want->uniqueKeys as $unique) {
                $found = false;
                foreach ($got->uniqueKeys as $g) {
                    $found = $found || $g->columns === $unique->columns;
                }
                if (!$found) {
                    $out[] = "table $name has no unique key (" . implode(', ', $unique->columns) . ')';
                }
            }
        }
        return $out;
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
     * database가 document set과 같은지 확인한다(docs/schema.md "Schema installation").
     * `$live`는 연결의 database를 introspect한 문서, `$unsupported`는 introspection이 읽지
     * 못한 객체, `$target`은 document set의 schema text 문서다. set에 없는 database의 table은
     * 비교하지 않는다. set의 table에 읽지 못한 객체가 있으면 그 객체를
     * "unsupported_<kind> <table>[.<name>]: <reason>"로, 아니면 database에 있는 set의 table에서
     * set까지의 모든 차이를 "<kind> <table>[.<name>]"로 돌려준다. 빈 목록이면 같다.
     *
     * @param list<Unsupported> $unsupported
     * @return list<string>
     */
    public static function installedDifferences(Document $live, array $unsupported, Document $target): array
    {
        [, $source, $comparison, $differences] = self::compareSet($live, $unsupported, $target);
        if ($source === null) {
            return $differences;
        }
        foreach ($comparison->differences ?? [] as $d) {
            $differences[] = "{$d->kind} " . self::qualified($d->table, $d->name);
        }
        return $differences;
    }

    /**
     * database에 있는 set의 table(source)과 set을 비교한다. set의 table에 읽지 못한 객체가
     * 있으면 source 없이 그 객체를 차이로 돌려준다. 아니면 set의 table 이름별 정의, source,
     * 비교 결과와 그 diagnostic을 돌려준다.
     *
     * @param list<Unsupported> $unsupported
     * @return array{0: array<string, Table>, 1: ?Document, 2: ?ComparisonResult, 3: list<string>}
     */
    private static function compareSet(Document $live, array $unsupported, Document $target): array
    {
        $declared = [];
        foreach ($target->tables as $table) {
            $declared[$table->name] = $table;
        }
        $differences = [];
        // set의 table에 읽지 못한 객체가 있으면 그 table은 set과 같다고 할 수 없다.
        foreach ($unsupported as $u) {
            if (isset($declared[$u->table])) {
                $differences[] = "unsupported_{$u->kind} " . self::qualified($u->table, $u->name) . ": {$u->reason}";
            }
        }
        if ($differences !== []) {
            return [$declared, null, null, $differences];
        }
        $source = new Document('schema');
        foreach ($live->tables as $table) {
            if (isset($declared[$table->name])) {
                $source->tables[] = $table;
            }
        }
        $comparison = self::compareSchemas($source, $target);
        foreach ($comparison->diagnostics as $d) {
            $differences[] = "{$d->rule}: {$d->message}";
        }
        return [$declared, $source, $comparison, $differences];
    }

    private static function qualified(string $table, string $name): string
    {
        return $name === '' ? $table : "$table.$name";
    }

    /**
     * 연결의 addTablesAndColumns가 실행할 step이다(docs/schema.md "Adding tables and
     * columns"). `$live`는 연결의 database를 introspect한 문서, `$unsupported`는
     * introspection이 읽지 못한 객체, `$target`은 document set의 schema text 문서다. set에
     * 없는 database의 table은 비교하지도 바꾸지도 않는다. database에 있는 set의 table과
     * set의 차이가 database에 없는 table의 create_table, null이거나 default가 있는
     * column의 add_column, unique가 아닌 index의 add_index뿐이면, database에 있는 set의
     * table에서 set까지의 plan step(docs/plans.md "Steps")과, table 이름 순으로 만드는
     * table은 "table", 더하는 column은 column 순서로 "table.column", 그 뒤 더하는 index는
     * index 순서로 "table.index"인 목록을 돌려준다. 다른 차이는 step 없이
     * "<kind> <table>[.<name>]"로 돌려주며, 빠진 unique key는 있는 행에서 실패할 수 있으므로
     * 그 이유와 함께 돌려준다.
     *
     * @param list<Unsupported> $unsupported
     * @return array{0: list<string>, 1: list<PlanStep>, 2: list<string>} 만드는 table과 더하는 column, step, 차이
     */
    public static function addTablesAndColumnsSteps(Document $live, array $unsupported, Document $target, string $dialect): array
    {
        $qualified = self::qualified(...);
        [$declared, $source, $comparison, $differences] = self::compareSet($live, $unsupported, $target);
        if ($source === null) {
            return [[], [], $differences];
        }
        $adding = [];
        foreach ($comparison->differences ?? [] as $d) {
            if ($d->kind === 'create_table') {
                $adding[$d->table] = true;
                continue;
            }
            if ($d->kind === 'add_column') {
                $column = null;
                foreach ($declared[$d->table]->columns as $c) {
                    if ($c->name === $d->name) {
                        $column = $c;
                    }
                }
                if ($column === null || $column->identity || (!$column->nullable && $column->default === null)) {
                    $differences[] = 'add_column ' . $qualified($d->table, $d->name) . ' without null or default';
                    continue;
                }
                $adding[$qualified($d->table, $d->name)] = true;
                continue;
            }
            if ($d->kind === 'add_index') {
                // index는 행을 거부하지 않으므로 있는 table에도 더한다.
                $adding[$qualified($d->table, $d->name)] = true;
                continue;
            }
            if ($d->kind === 'add_unique') {
                // unique key는 있는 행이 겹치면 실패하므로 plan과 apply가 다룬다.
                $differences[] = 'add_unique ' . $qualified($d->table, $d->name) . ': a missing unique key can fail on the existing rows; add it with a plan';
                continue;
            }
            $differences[] = "{$d->kind} " . $qualified($d->table, $d->name);
        }
        if ($differences !== [] || $adding === []) {
            return [[], [], $differences];
        }
        // 만드는 table과 더하는 column과 index는 table 이름 순, table 안에서는 column 순서 뒤
        // index 순서다.
        $added = [];
        foreach ($target->tables as $table) {
            if (isset($adding[$table->name])) {
                $added[] = $table->name;
                continue;
            }
            foreach ($table->columns as $c) {
                if (isset($adding[$qualified($table->name, $c->name)])) {
                    $added[] = $qualified($table->name, $c->name);
                }
            }
            foreach ($table->indexes as $i) {
                if (isset($adding[$qualified($table->name, $i->name)])) {
                    $added[] = $qualified($table->name, $i->name);
                }
            }
        }
        // 더하는 table과 column은 plan 하나로 쓴다. plan은 database에 있는 set의 table에서
        // 시작하므로(하나도 없으면 빈 database) step은 docs/plans.md의 순서와 rollback을
        // 그대로 갖는다.
        $diagnostics = [];
        $steps = [];
        $start = $source->tables === [] ? null : $source;
        $from = null;
        if ($start !== null) {
            $manifest = self::manifest([$start]);
            if ($manifest->manifest === null) {
                $diagnostics = $manifest->diagnostics;
            } else {
                $from = $manifest->manifest->schemaHash;
            }
        }
        if ($diagnostics === []) {
            // target 은 외부 문서를 쓰는 set 의 schema text 일 수 있으므로 plan 문서를 parse 하지 않고
            // target 으로 plan 을 만든다.
            $plan = PlanText::planTo('add_tables_and_columns', $from, [], [], [], [], $target, self::emit($target));
            if ($plan->plan === null) {
                $diagnostics = $plan->diagnostics;
            } else {
                $written = self::planSteps($start, $plan->plan, $dialect);
                $diagnostics = $written->diagnostics;
                $steps = $written->steps ?? [];
            }
        }
        foreach ($diagnostics as $d) {
            $differences[] = "{$d->rule}: {$d->message}";
        }
        if ($differences !== []) {
            return [[], [], $differences];
        }
        return [$added, $steps, []];
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
