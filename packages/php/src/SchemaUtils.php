<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\Orm\Dbspec\CatalogRows;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\DocumentSet;
use Polyspec\Orm\Dbspec\Renderer;

/** Schema installation and inspection. */
final class SchemaUtils
{
    public function __construct(private readonly Db $db, private readonly Utils $u)
    {
    }

    /**
     * Registers the generated schema's set on this connection. It reads and writes nothing in the database:
     * the manifest text is checked to hash to its declared hash (otherwise CONFIG), and the set is only
     * registered. Registering the same set again changes nothing. Whether the database matches the set is
     * checked by install and
     * addTablesAndColumns at setup and upgrade, and by the connection opened for each request as well.
     * register sets the set without any statement (docs/spec/schema.md "Schema registration").
     */
    public function register(Schema $schema): void
    {
        $this->db->registerSet($schema);
    }

    /**
     * Installs the generated schema's document set into the connection's database, and after checking that
     * the database matches the set, registers that set on this connection. If the manifest text does not
     * hash to its declared hash, it is CONFIG before any statement. If the set has a diagnostic, it is
     * SCHEMA_INVALID. Introspects the connection's database; if a table that external documents use differs
     * from the external document, it is CONFIG.
     * If the set owns no tables, the client's renderer creates all the statements (docs/spec/dialects.md
     * "Rendered statements"); if all of them exist, nothing is created; if only some exist, it is
     * CONFIG. Then it rereads the database and compares the tables the set owns with the set; if there is a difference,
     * it is CONFIG with all of those differences (docs/spec/schema.md "Schema installation"). On PostgreSQL and
     * SQLite, it runs inside a transaction (in progress or new), so a failed install leaves
     * nothing behind. MySQL commits each DDL by itself, so it runs outside a transaction, and
     * inside one it is CONFIG.
     */
    public function install(Schema $schema): void
    {
        $this->db->unsupportedOnMarkdown('schema install (flowmark install creates a corpus)');
        $schema->verify();
        $driver = $this->db->driver();
        $documents = $schema->documents();
        [, $diagnostics] = DocumentSet::check($documents);
        if ($diagnostics !== []) {
            throw self::invalid($diagnostics);
        }
        $statements = Renderer::statements($documents, $driver);
        if ($statements === []) {
            throw new OrmException(Code::CONFIG, 'the document set has no tables');
        }
        $target = self::target($documents);
        $db = $this->db;
        $pdo = $db->pdo();
        $apply = fn(?int $tx) => $this->observed(
            $tx,
            static function () use ($db, $pdo, $tx, $statements, $driver, $documents, $target): void {
                try {
                    $live = self::introspectSet($pdo, $driver, $documents);
                    $found = [];
                    foreach ($live->document->tables as $table) {
                        $found[$table->name] = true;
                    }
                    foreach ($live->unsupported as $u) {
                        $found[$u->table] = true;
                    }
                    $present = [];
                    $missing = [];
                    foreach ($target->tables as $table) {
                        if (isset($found[$table->name])) {
                            $present[] = $table->name;
                        } else {
                            $missing[] = $table->name;
                        }
                    }
                    if ($present !== [] && $missing !== []) {
                        throw new OrmException(
                            Code::CONFIG,
                            'the database holds only some tables of the document set: ' . implode(', ', $present)
                        );
                    }
                    if ($missing !== []) {
                        foreach ($statements as [$statement, $table]) {
                            $db->run(StatementEvent::SCHEMA, [$table], $tx, $statement);
                        }
                        $live = Dbspec::introspect($pdo, $driver, 'schema');
                    }
                    self::verifySet(Dbspec::installedDifferences($live->document, $live->unsupported, $target));
                } catch (\PDOException $e) {
                    throw $db->driverError($e);
                }
            }
        );
        if ($driver !== 'mysql') {
            $this->u->run(fn() => $apply($db->transactionNumber()));
        } else {
            if (Db::activeFor($this->db) !== null) {
                throw new OrmException(
                    Code::CONFIG,
                    'MySQL commits schema statements implicitly; install outside a transaction'
                );
            }
            $apply(null);
        }
        $this->db->registerSet($schema);
    }

    /**
     * Upgrades the installed document set only by adding it as a new version of the generated schema
     * (docs/spec/schema.md "Adding tables and columns"). Introspects the connection's database and compares
     * the set's tables that are in the database with the set, creates tables of the set that are not in the
     * database, together with their indexes, foreign keys, checks, and triggers, and adds to existing tables
     * the missing columns that are null or have a default. adds those columns. It runs the plan steps of
     * Dbspec::addTablesAndColumnsSteps, so the changed tables' audit triggers are also changed to record the
     * new columns. Tables of other sets are left as they are, and the set is not registered. Any other
     * difference is SCHEMA_DIFFERS before any statement. The manifest text is first CONFIG if it does not
     * hash to its declared hash. PostgreSQL applies it in an in-progress transaction or a new one. MySQL
     * commits schema statements implicitly, and SQLite rebuilds a table with foreign keys turned off to add
     * a column, but the foreign key setting does not change inside a transaction, so both are applied
     * outside a transaction, and inside one it is CONFIG.
     *
     * @return list<string> Created tables are "table", added columns are "table.column", in table name and column order
     */
    public function addTablesAndColumns(Schema $schema): array
    {
        $this->db->unsupportedOnMarkdown('addTablesAndColumns (schema evolution follows the flowmark migration rules)');
        $schema->verify();
        $driver = $this->db->driver();
        $documents = $schema->documents();
        $document = self::target($documents);
        $db = $this->db;
        $pdo = $db->pdo();
        $apply = fn(?int $tx): array => $this->observed(
            $tx,
            static function () use ($db, $pdo, $tx, $driver, $document, $documents): array {
                try {
                    $live = self::introspectSet($pdo, $driver, $documents);
                    [$added, $steps, $differences] = Dbspec::addTablesAndColumnsSteps(
                        $live->document,
                        $live->unsupported,
                        $document,
                        $driver
                    );
                    if ($differences !== []) {
                        throw new OrmException(
                            Code::SCHEMA_DIFFERS,
                            'the existing tables of the document set differ beyond missing tables, missing columns '
                            . 'that '
                            . 'are null or have a default and missing indexes: '
                            . implode('; ', $differences)
                        );
                    }
                    foreach ($steps as $step) {
                        // A step creates or changes the table of its effect.
                        $db->run(
                            StatementEvent::SCHEMA,
                            $step->effect->table === '' ? [] : [$step->effect->table],
                            $tx,
                            $step->statement
                        );
                    }
                    // Reads the database again after the steps and checks that it matches the set.
                    if ($steps !== []) {
                        $live = Dbspec::introspect($pdo, $driver, 'schema');
                    }
                    self::verifySet(Dbspec::installedDifferences($live->document, $live->unsupported, $document));
                    return $added;
                } catch (\PDOException $e) {
                    throw $db->driverError($e);
                }
            }
        );
        if ($driver === 'postgres') {
            return $this->u->run(fn(): array => $apply($db->transactionNumber()));
        }
        if (Db::activeFor($this->db) !== null) {
            throw new OrmException(Code::CONFIG, "$driver adds tables and columns outside a transaction: "
                . "MySQL commits schema statements implicitly and SQLite turns foreign keys off to rebuild a table");
        }
        if ($driver === 'mysql') {
            return $apply(null);
        }
        return $this->withoutForeignKeys($apply);
    }

    /**
     * During $fn, publishes a schema event for each introspection catalog query.
     * A catalog query does not point at a table. $tx is the transaction number of that query.
     *
     * @template T
     * @param \Closure(): T $fn
     * @return T
     */
    private function observed(?int $tx, \Closure $fn): mixed
    {
        $db = $this->db;
        return CatalogRows::observed(
            static function (string $query, int $start, ?\Throwable $failure) use ($db, $tx): void {
                $error = match (true) {
                    $failure === null => null,
                    $failure instanceof \PDOException => $db->driverError($failure),
                    default => new OrmException(Code::DRIVER, $failure->getMessage(), $failure),
                };
                $db->publish(StatementEvent::SCHEMA, [], $tx, $query, [], $start, $error);
            },
            $fn
        );
    }

    /**
     * Introspects the connection's database; if a table the set uses from an external document differs from
     * that external document, it is CONFIG (docs/spec/dbspec.md "External documents").
     *
     * @param list<\Polyspec\Orm\Dbspec\Document> $documents
     */
    private static function introspectSet(
        \PDO $pdo,
        string $driver,
        array $documents
    ): \Polyspec\Orm\Dbspec\IntrospectResult {
        $live = Dbspec::introspect($pdo, $driver, 'schema');
        $differences = Dbspec::externalDifferences($live->document, $documents);
        if ($differences !== []) {
            throw self::externalError($differences);
        }
        return $live;
    }

    /**
     * If the database differs from the set, it is CONFIG with all of those differences.
     *
     * @param list<string> $differences
     */
    private static function verifySet(array $differences): void
    {
        if ($differences !== []) {
            throw new OrmException(
                Code::CONFIG,
                'the database differs from the document set: ' . implode('; ', $differences)
            );
        }
    }

    /**
     * The schema text document of the set, which is what the database is compared with. The schema text
     * uses external documents as use lines, so the external document's text is parsed into the set.
     *
     * @param list<\Polyspec\Orm\Dbspec\Document> $documents
     */
    private static function target(array $documents): \Polyspec\Orm\Dbspec\Document
    {
        $manifest = Dbspec::manifest($documents);
        $externalTexts = [];
        foreach ($documents as $document) {
            if ($document->external) {
                $externalTexts[$document->name] = Dbspec::emit($document);
            }
        }
        $target = $manifest->manifest === null ? null : Dbspec::parse($manifest->manifest->schemaText, $externalTexts);
        $diagnostics = $manifest->manifest === null ? $manifest->diagnostics : $target->diagnostics;
        if ($diagnostics !== []) {
            throw self::invalid($diagnostics);
        }
        return $target->document;
    }

    /** @param list<\Polyspec\Orm\Dbspec\Diagnostic> $diagnostics */
    private static function invalid(array $diagnostics): OrmException
    {
        $lines = array_map(static fn($d): string =>
            "{$d->line}:{$d->column}: {$d->rule}: {$d->message}", $diagnostics);
        return new OrmException(Code::SCHEMA_INVALID, implode("\n", $lines));
    }

    /** @param list<string> $differences */
    private static function externalError(array $differences): OrmException
    {
        return new OrmException(
            Code::CONFIG,
            'the tables that the set uses from external documents differ from the database: ' . implode(
                '; '
                . '',
                $differences
            )
        );
    }

    /**
     * Runs $fn inside a BEGIN IMMEDIATE transaction with SQLite's foreign keys turned off,
     * and commits only if the foreign key check returns no rows, then turns foreign keys back
     * on (docs/spec/plans.md "Apply"'s SQLite rebuild).
     *
     * This transaction also takes one transaction number of the connection.
     *
     * @param \Closure(int): list<string> $fn
     * @return list<string>
     */
    private function withoutForeignKeys(\Closure $fn): array
    {
        $db = $this->db;
        $db->run(StatementEvent::UTILITY, [], null, 'PRAGMA foreign_keys = OFF');
        try {
            $tx = $db->nextTransaction();
            $began = false;
            try {
                $db->run(StatementEvent::BEGIN, [], $tx, 'BEGIN IMMEDIATE');
                $began = true;
                $added = $fn($tx);
                $broken = (int) ($db->fetch(
                    StatementEvent::SCHEMA,
                    [],
                    $tx,
                    'SELECT COUNT(*) FROM pragma_foreign_key_check'
                )[0][0] ?? 0);
                if ($broken > 0) {
                    throw new OrmException(Code::INTERNAL, "the rebuilt tables break $broken foreign keys");
                }
            } catch (\Throwable $e) {
                // Even if a subscriber fails after BEGIN, the transaction was started, so it is also judged by the
                // driver's state.
                if ($began || $db->pdo()->inTransaction()) {
                    try {
                        $db->run(StatementEvent::ROLLBACK, [], $tx, 'ROLLBACK');
                    } catch (OrmException $rollback) {
                        throw OrmException::rollback($e, $rollback);
                    }
                }
                throw $e;
            }
            $db->run(StatementEvent::COMMIT, [], $tx, 'COMMIT');
            return $added;
        } finally {
            $db->run(StatementEvent::UTILITY, [], null, 'PRAGMA foreign_keys = ON');
        }
    }

    private function bool(string $sql, array $args): bool
    {
        $this->db->unsupportedOnMarkdown('schema inspection');
        return (bool) $this->u->read(StatementEvent::SCHEMA, [], $sql, $args);
    }

    private static function name(string $name): string
    {
        if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name) !== 1) {
            throw new OrmException(Code::CONFIG, "identifier $name is invalid");
        }
        return $name;
    }

    public function exists(string $schema): bool
    {
        $schema = self::name($schema);
        return match ($this->db->driver()) {
            'postgres' => $this->bool('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)', [$schema]),
            'mysql' => $this->bool(
                'SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)',
                [$schema]
            ),
            default => $this->bool(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name "
                . "LIKE ? ESCAPE '\\')",
                [str_replace('_', '\\_', $schema) . '\\_\\_%']
            ),
        };
    }

    public function installed(string $schema, string $table): bool
    {
        $schema = self::name($schema);
        $table = self::name($table);
        return match ($this->db->driver()) {
            'postgres' => $this->bool('SELECT to_regclass($1) IS NOT NULL', [$schema . '.' . $table]),
            'mysql' => $this->bool(
                'SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND '
                . 'TABLE_NAME = ?)',
                [$schema, $table]
            ),
            default => $this->bool(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name "
                . "= ?)",
                [$schema . '__' . $table]
            ),
        };
    }

    /**
     * Reports whether the database holds no user content. On PostgreSQL a schema
     * other than public, information_schema and the pg_ schemas is content even
     * without objects, and so is a table, partitioned table, view, materialized
     * view or foreign table in public. On MySQL a table or view of the connected
     * database is content, and on SQLite a table or view other than the sqlite_
     * and orm__ tables is content.
     */
    public function empty(): bool
    {
        return match ($this->db->driver()) {
            'postgres' => $this->bool("SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE "
                . "'pg\\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR EXISTS (SELECT 1 FROM "
                    . "pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))))", []),
            'mysql' => $this->bool('SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = '
                . 'DATABASE())', []),
            default => $this->bool("SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND "
                . "name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'orm\\_\\_%' ESCAPE '\\')", []),
        };
    }
}
