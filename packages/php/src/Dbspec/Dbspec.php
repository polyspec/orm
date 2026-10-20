<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** Parses, validates and canonically emits dbspec documents (docs/spec/dbspec.md). */
final class Dbspec
{
    /**
     * Parses a document. `$documents` is the declared document set, document
     * name => text, in which `use` lines find the documents they name. The
     * result holds the document, its declaration positions in source order
     * (docs/spec/dbspec.md "Declaration positions"), and no diagnostics; or every
     * diagnostic in source order, no document and no positions.
     *
     * @param array<string, string> $documents
     */
    public static function parse(string $text, array $documents): ParseResult
    {
        [$document, $diagnostics, $positions] = self::read($text, $documents, false);
        return $document === null ? ParseResult::invalid($diagnostics) : ParseResult::valid($document, $positions);
    }

    /**
     * Parses a document as parse does and returns that result unchanged, with the tokens of the text: each
     * with its line, its start and end in code points and its class (docs/spec/dbspec.md "Syntax analysis").
     * A limit error gives no tokens.
     *
     * @param array<string, string> $documents
     */
    public static function analyze(string $text, array $documents): Analysis
    {
        [$document, $diagnostics, $positions, $tokens] = self::read($text, $documents, true);
        return new Analysis($document, $positions, $diagnostics, $tokens);
    }

    /**
     * The canonical emission of the text when it has no diagnostic; otherwise every diagnostic and no text. A document
     * with a diagnostic is never rewritten (docs/spec/dbspec.md "Formatting").
     *
     * @param array<string, string> $documents
     */
    public static function format(string $text, array $documents): FormatResult
    {
        [$document, $diagnostics] = self::read($text, $documents, false);
        if ($document === null) {
            return new FormatResult(null, $diagnostics);
        }
        return new FormatResult(self::emit($document), []);
    }

    /**
     * @param array<string, string> $documents
     * @return array{0: ?Document, 1: list<Diagnostic>, 2: ?list<Position>, 3: list<Token>}
     */
    private static function read(string $text, array $documents, bool $withTokens): array
    {
        foreach ($documents as $name => $source) {
            if (!is_string($name) || !is_string($source)) {
                throw new \InvalidArgumentException('The declared document set maps document names to texts');
            }
        }
        return (new Parser($documents))->run($text, $withTokens);
    }

    /** The first byte of every dbspec document file. The header `dbspec 1 <document>` starts with this. */
    public const SIGNATURE = 'dbspec ';

    /**
     * Reads the dbspec document file at $path to parse, and checks its bytes against the path as the name in
     * readBytes (docs/spec/dbspec.md "Files"). A directory or an unreadable file is a
     * RuntimeException "cannot read <path>: <reason>".
     */
    public static function readFile(string $path): ReadResult
    {
        // PHP opens a directory and reads empty text, so it is rejected before it becomes an empty file's
        // signature diagnostic.
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
     * Reads the set file at $path and the files it lists (docs/spec/dbspec.md "Document sets"): the set file,
     * its JSON, each path and the read with the file identity, in that order. The result holds the files
     * of `documents` and `external` with their joined path and their unchecked bytes, or every error by
     * step, then by path; the caller gives each file's bytes to readBytes with its path.
     */
    public static function readSet(string $path): SetResult
    {
        return SetReader::read($path);
    }

    /**
     * Parses the texts of one document set (docs/spec/dbspec.md "Parsing a set"): $owned, then $external, each in set
     * order, and returns one result per text in that order. Each text's name is the name the parser reads from its
     * header; a text whose name an earlier text has is not parsed, and its result carries the one diagnostic
     * `name.duplicate`. Every other text is parsed with the texts of all
     * other named documents as the documents its use lines name, and an external text's document is marked external.
     *
     * @param list<string> $owned
     * @param list<string> $external
     * @return list<SetDocument>
     */
    public static function parseSet(array $owned, array $external): array
    {
        $texts = [];
        foreach ([[$owned, false], [$external, true]] as [$list, $isExternal]) {
            foreach ($list as $text) {
                if (!is_string($text)) {
                    throw new \InvalidArgumentException('A document set holds texts');
                }
                $texts[] = [$text, $isExternal];
            }
        }
        $names = [];
        $named = [];
        $repeated = [];
        foreach ($texts as $i => [$text]) {
            $name = Parser::headerName($text);
            $names[$i] = $name;
            if ($name !== '') {
                if (isset($named[$name])) {
                    $repeated[$i] = true;
                    continue;
                }
                $named[$name] = $text;
            }
        }
        $documents = [];
        foreach ($texts as $i => [$text, $isExternal]) {
            if (isset($repeated[$i])) {
                $diagnostic = new Diagnostic('name.duplicate', 1, 10,
                    "document {$names[$i]} appears twice in the document set");
                $documents[] = new SetDocument($names[$i], $isExternal, null, null, [$diagnostic]);
                continue;
            }
            $others = $named;
            unset($others[$names[$i]]);
            $result = self::parse($text, $others);
            if ($result->document !== null) {
                $result->document->external = $isExternal;
            }
            $documents[] = new SetDocument($names[$i], $isExternal, $result->document, $result->positions,
                $result->diagnostics);
        }
        return $documents;
    }

    /**
     * Checks the bytes of a dbspec document file, which the caller read by its own rules, before parse.
     * $name is the name by which the message refers to the file. Bytes not starting with SIGNATURE give no
     * text, but one `signature` diagnostic at line 1, column 1 with the message "<name> is not a dbspec
     * document", and non-UTF-8 bytes give an `encoding` diagnostic at the line and column of the first bad
     * byte, with the message "<name> is not valid UTF-8". Other bytes pass through as text without a
     * diagnostic.
     * as is.
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
     * The line and column (in code points) of the first bad UTF-8 byte. Lines are split at LF.
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

    /** The number of bytes of the valid UTF-8 character starting at $i, or 0 if the byte is invalid. */
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
        Graph::document($document);
        return Emitter::emit($document, View::Canonical);
    }

    /**
     * The statements that create the tables of the document set in one
     * dialect, `mysql`, `postgres` or `sqlite` (docs/spec/dialects.md "Rendered
     * statements"), or the diagnostics of the set (docs/spec/dbspec.md "Manifest
     * and hashes"). An unknown dialect is an InvalidArgumentException.
     *
     * @param list<Document> $documents
     */
    public static function render(array $documents, string $dialect): RenderResult
    {
        if (!in_array($dialect, Renderer::DIALECTS, true)) {
            throw new \InvalidArgumentException("Unknown dialect `$dialect`; the dialects are mysql, postgres "
                . "and sqlite");
        }
        Graph::documents($documents, 'the document set');
        [, $diagnostics] = DocumentSet::check($documents);
        return $diagnostics === [] ? RenderResult::valid(Renderer::render($documents, $dialect))
            : RenderResult::invalid($diagnostics);
    }

    /**
     * Reads the current database (MySQL), the current schema (PostgreSQL) or
     * the main database (SQLite) of the connection into one document named
     * `$name` and the objects it leaves out (docs/spec/dialects.md
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
            default => throw new \InvalidArgumentException("Unknown dialect `$dialect`; the dialects are mysql, "
                . "postgres and sqlite"),
        };
        return $catalog->document($name);
    }

    /**
     * The manifest of the document set, whose documents are taken in document
     * name order, or the diagnostics of the set (docs/spec/dbspec.md "Manifest and
     * hashes").
     *
     * @param list<Document> $documents
     */
    public static function manifest(array $documents): ManifestResult
    {
        Graph::documents($documents, 'the document set');
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
        // Schema text is one document `schema` holding all the tables the set owns in name order, so the way
        // documents are split does not matter. Tables used from an external document remain as a use line in
        // that document.
        usort($tables, static fn(Table $a, Table $b): int => strcmp($a->name, $b->name));
        $schema->tables = $tables;
        $schemaText = Emitter::emit($schema, View::Schema);
        return ManifestResult::valid(new Manifest($manifestText, $schemaText,
            'sha256:' . hash('sha256', $manifestText . $externalText), 'sha256:' . hash('sha256', $schemaText),
            $externalText));
    }

    /**
     * Only the columns, primary key, unique keys, the foreign keys whose referenced table is also one of
     * $tables, and the indexes whose leading columns are such a foreign key's columns, of $tables, from the
     * external document, in document order (docs/spec/dbspec.md "Manifest and hashes"), so the reduced text
     * satisfies the validation of the full document. If that table is absent, null. Other foreign keys,
     * indexes, checks, and settings are owned by the external document, so
     * they are not included.
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
            $trimmed->uniqueKeys = array_map(static fn(UniqueKey $u): UniqueKey =>
                new UniqueKey($u->name, $u->columns), $table->uniqueKeys);
            foreach ($table->foreignKeys as $f) {
                if (in_array($f->table, $tables, true)) {
                    $trimmed->foreignKeys[] = new ForeignKey($f->name, $f->columns, $f->table,
                        $f->referencedColumns, $f->onDelete, $f->onUpdate);
                }
            }
            foreach ($table->indexes as $x) {
                $names = array_map(static fn(IndexColumn $c): string => $c->name, $x->columns);
                foreach ($trimmed->foreignKeys as $f) {
                    if (array_slice($names, 0, count($f->columns)) === $f->columns) {
                        $trimmed->indexes[] = new Index($x->name, $x->columns);
                        break;
                    }
                }
            }
            $out->tables[] = $trimmed;
        }
        return $out->tables === [] ? null : $out;
    }

    /**
     * Checks that the tables the set uses from external documents are in the database (docs/spec/dbspec.md
     * "External documents"). $live is the document of the introspected database. For each table written, if
     * the table is missing, or an external document column is missing, or its type or null differs, or the
     * primary key differs, or the unique key's columns list is missing, returns those differences by table
     * name and column order. With no external document, it is an empty list.
     *
     * @param list<Document> $documents
     * @return list<string>
     */
    public static function externalDifferences(Document $live, array $documents): array
    {
        Graph::document($live);
        Graph::documents($documents, 'the document set');
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
                    $out[] = "column $name.{$column->name} is {$nullText($g->nullable)}, "
                        . "not {$nullText($column->nullable)}";
                }
            }
            $gotKey = $got->primaryKey?->columns ?? [];
            $wantKey = $want->primaryKey?->columns ?? [];
            if ($gotKey !== $wantKey) {
                $out[] = "table $name has the primary key (" . implode(', ', $gotKey) . '), not ('
                    . implode(', ', $wantKey) . ')';
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
     * Reads a plan document (docs/spec/plans.md "Plan document"): a plan and no
     * diagnostics, or one diagnostic located in the plan.
     */
    public static function parsePlan(string $text): PlanParseResult
    {
        return PlanText::parse($text);
    }

    /** Writes a plan in its canonical text: `emitPlan(parsePlan(s)) === s` for canonical input. */
    public static function emitPlan(Plan $plan): string
    {
        Graph::plan($plan);
        return PlanText::emit($plan);
    }

    /**
     * The plans in chain order from the empty database, or the `chain`
     * diagnostics that name the plans (docs/spec/plans.md "Chain").
     *
     * @param list<Plan> $plans
     */
    public static function chain(array $plans): ChainResult
    {
        Graph::plans($plans, 'the plans');
        return PlanChain::chain($plans);
    }

    /**
     * The changes from the source schema, null for the empty database, to the
     * plan's target, or the `plan` diagnostics (docs/spec/plans.md "Diff").
     */
    public static function diff(?Document $source, Plan $plan): DiffResult
    {
        if ($source !== null) {
            Graph::document($source);
        }
        Graph::plan($plan);
        [$diff, $diagnostics] = PlanDiff::of($source, $plan);
        return $diff === null ? DiffResult::invalid($diagnostics) : DiffResult::valid($diff->changes);
    }

    /**
     * All differences from source to target without a plan, or the diagnostic `compare` of the side that is not
     * schema text
     * (docs/spec/plans.md "Comparison").
     */
    public static function compareSchemas(Document $source, Document $target): ComparisonResult
    {
        Graph::document($source);
        Graph::document($target);
        return SchemaComparison::compare($source, $target);
    }

    /**
     * Checks whether the database matches the document set (docs/spec/schema.md "Schema installation").
     * $live is the document of the connection's database introspected; $unsupported is the objects introspection
     * could not
     * read; $target is the schema text document of the document set. Tables of the database that are not in the set are
     * not compared. If a table in the set has an unread object, that object is
     * reported as "unsupported_<kind> <table>[.<name>]: <reason>"; otherwise, for tables of the set in the database,
     * all differences up to the set are reported as "<kind> <table>[.<name>]". An empty list means they match.
     *
     * @param list<Unsupported> $unsupported
     * @return list<string>
     */
    public static function installedDifferences(Document $live, array $unsupported, Document $target): array
    {
        Graph::document($live);
        Graph::unsupported($unsupported, 'the unsupported objects');
        Graph::document($target);
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
     * Compares the set's tables (source) that are in the database with the set. If a table in the set has an
     * unread object, that object is returned as a difference without a source. Otherwise, the definitions by
     * table name of the set, source,
     * Returns the comparison result and its diagnostic.
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
        // If a table in the set has an unread object, that table cannot be called the same as the set.
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
     * The steps that the connection's addTablesAndColumns will run (docs/spec/schema.md "Adding tables and
     * columns"). `$live` is the document of the connection's introspected database, `$unsupported` is
     * the objects introspection could not read, and `$target` is the schema text document of the document set.
     * For the set tables of the database not in the set are neither compared nor changed. The set's tables that
     * are in the database and differ from the set: a create_table for a table missing from the database, an
     * add_column for a column that is null or has a default,
     * or an add_index for a non-unique index only; the set's tables that are in the database
     * get plan steps up to the set (docs/spec/plans.md "Steps"), and returns, in table name order, the list of
     * tables as "table", added columns as "table.column" in column order, and then added indexes
     * as "table.index" in index order. Other differences are returned without a step
     * as "<kind> <table>[.<name>]", and since a missing unique key can fail on existing rows,
     * it is returned with that reason.
     *
     * @param list<Unsupported> $unsupported
     * @return array{0: list<string>, 1: list<PlanStep>, 2: list<string>} The tables to create, the columns to
     *     add, the steps, and the differences
     */
    public static function addTablesAndColumnsSteps(Document $live, array $unsupported, Document $target,
        string $dialect): array
    {
        Graph::document($live);
        Graph::unsupported($unsupported, 'the unsupported objects');
        Graph::document($target);
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
                // An index does not reject rows, so it is added to existing tables too.
                $adding[$qualified($d->table, $d->name)] = true;
                continue;
            }
            if ($d->kind === 'add_unique') {
                // A unique key fails if existing rows overlap, so plan and apply handle it.
                $differences[] = 'add_unique ' . $qualified($d->table, $d->name)
                    . ': a missing unique key can fail on the existing rows; add it with a plan';
                continue;
            }
            $differences[] = "{$d->kind} " . $qualified($d->table, $d->name);
        }
        if ($differences !== [] || $adding === []) {
            return [[], [], $differences];
        }
        // Tables to create, columns to add, and indexes are in table name order; within a table, after column order
        // comes index order.
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
        // Tables and columns to add are written as one plan. The plan starts from the set's tables that are in
        // the database
        // (an empty database if there are none), so the steps keep the order and rollback of docs/spec/plans.md
        // as they are.
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
            // The target may be the schema text of a set that uses external documents, so the plan document is not
            // parsed and
            // the plan is built from the target.
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
     * (docs/spec/plans.md "Steps"). An unknown dialect is an
     * InvalidArgumentException.
     */
    public static function planSteps(?Document $source, Plan $plan, string $dialect): PlanStepsResult
    {
        $renderer = new Renderer($dialect);
        if ($source !== null) {
            Graph::document($source);
        }
        Graph::plan($plan);
        [$diff, $diagnostics] = PlanDiff::of($source, $plan);
        return $diff === null ? PlanStepsResult::invalid($diagnostics)
            : PlanStepsResult::valid(PlanSteps::write($diff, $renderer, $plan));
    }

    /**
     * Applies, step by step, the plans of the chain that the database of the
     * connection has not applied, up to their finalize steps (docs/spec/plans.md
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
    public static function apply(\PDO $connection, string $dialect, array $plans, \Closure $now,
        ?\Closure $events): void
    {
        PlanApply::apply($connection, $dialect, $plans, $now, $events);
    }

    /**
     * Continues the interrupted plan forward: it reads in the catalog whether
     * the statement after the recorded step took effect and runs the rest,
     * up to `applied`, or to `done` for a finalizing plan (docs/spec/plans.md
     * "Apply"). Without an interrupted plan nothing changes. Failures and
     * arguments are as for apply.
     *
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function recover(\PDO $connection, string $dialect, array $plans, \Closure $now,
        ?\Closure $events): void
    {
        PlanApply::recover($connection, $dialect, $plans, $now, $events);
    }

    /**
     * Undoes the last plan of the history with its rollback statements, down
     * to its first step, and deletes its row (docs/spec/plans.md "Apply"). An
     * applied plan is checked for drift and NULL rows first; a step without
     * rollback stops it with an `irreversible` ApplyError. Without a row
     * nothing changes. Failures and arguments are as for apply.
     *
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function rollback(\PDO $connection, string $dialect, array $plans, \Closure $now,
        ?\Closure $events): void
    {
        PlanApply::rollback($connection, $dialect, $plans, $now, $events);
    }

    /**
     * Runs the finalize steps of every applied plan in chain order, dropping
     * the hidden tables and columns, and records the plans `done`
     * (docs/spec/plans.md "Apply"). Failures and arguments are as for apply.
     *
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function finalize(\PDO $connection, string $dialect, array $plans, \Closure $now,
        ?\Closure $events): void
    {
        PlanApply::finalize($connection, $dialect, $plans, $now, $events);
    }

    /**
     * Writes the document as a standard Mermaid erDiagram and lists what the
     * diagram leaves out, as Unsupported in table, kind and name order
     * (docs/spec/mermaid.md "Export").
     */
    public static function exportMermaid(Document $document): MermaidExportResult
    {
        Graph::document($document);
        return Mermaid::export($document);
    }

    /**
     * Reads a standard Mermaid erDiagram into a document named `$name` and
     * lists what import leaves out (docs/spec/mermaid.md "Import"), or the
     * `mermaid` diagnostic of a line that does not follow the grammar.
     */
    public static function importMermaid(string $text, string $name): MermaidImportResult
    {
        return Mermaid::import($text, $name);
    }
}
