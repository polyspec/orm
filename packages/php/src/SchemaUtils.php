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
    public function __construct(private readonly Db $db, private readonly Utils $u) {}

    /**
     * generated schema의 set을 이 연결에 등록한다. database를 읽거나 쓰지 않는다: manifest
     * text가 선언한 hash로 hash되는지 확인하고(아니면 CONFIG) set을 등록할 뿐이다. 같은 set을
     * 다시 등록하면 아무것도 바꾸지 않는다. database가 set과 같은지는 install과
     * addTablesAndColumns가 설치와 upgrade 때 확인하며, 요청마다 연 연결에도
     * register가 statement 없이 set을 등록한다(docs/schema.md "Schema registration").
     */
    public function register(Schema $schema): void
    {
        $this->db->registerSet($schema);
    }

    /**
     * generated schema의 document set을 connection의 database에 설치하고, database가 set과
     * 같은지 확인한 뒤 그 set을 이 연결에 등록한다. manifest text가 선언한 hash로 hash되지
     * 않으면 어떤 statement보다 먼저 CONFIG다. 집합에 diagnostic이 있으면 SCHEMA_INVALID다.
     * 연결의 database를 introspect해, 외부 문서에서 쓰는 table이 외부 문서와 다르면 CONFIG다.
     * set이 소유한 table이 하나도 없으면 client의 renderer가 만든 statement(docs/dialects.md
     * "Rendered statements")로 모두 만들고, 모두 있으면 아무것도 만들지 않으며, 일부만 있으면
     * CONFIG다. 그다음 database를 다시 읽어 set이 소유한 table을 set과 비교하고, 차이가 있으면
     * 그 차이를 모두 담은 CONFIG다(docs/schema.md "Schema installation"). PostgreSQL과
     * SQLite는 진행 중인 transaction이나 새 transaction에서 적용하므로 실패한 install은
     * 아무것도 남기지 않는다. MySQL은 DDL마다 스스로 commit하므로 transaction 밖에서 실행하고
     * 안에서는 CONFIG다.
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
        $apply = fn(?int $tx) => $this->observed($tx, static function () use ($db, $pdo, $tx, $statements, $driver, $documents, $target): void {
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
                    throw new OrmException(Code::CONFIG, 'the database holds only some tables of the document set: ' . implode(', ', $present));
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
        });
        if ($driver !== 'mysql') {
            $this->u->run(fn() => $apply($db->transactionNumber()));
        } else {
            if (Db::activeFor($this->db) !== null) {
                throw new OrmException(Code::CONFIG, 'MySQL commits schema statements implicitly; install outside a transaction');
            }
            $apply(null);
        }
        $this->db->registerSet($schema);
    }

    /**
     * 설치한 document set을 generated schema의 새 version으로 더해서만 올린다(docs/schema.md
     * "Adding tables and columns"). 연결의 database를 introspect해 database에 있는 set의
     * table을 set과 비교하고, database에 없는 set의 table을 index, foreign key, check,
     * trigger와 함께 만들며, 있는 table에 빠진 column 가운데 null이거나 default가 있는
     * column을 더한다. Dbspec::addTablesAndColumnsSteps의 plan step을 실행하므로 바뀐 table의
     * audit trigger도 새 column을 기록하도록 바뀐다. 다른 set의 table은 그대로 두며 set을
     * 등록하지 않는다. 다른 차이는 어떤 statement보다 먼저 SCHEMA_DIFFERS다. manifest
     * text가 선언한 hash로 hash되지 않으면 먼저 CONFIG다. PostgreSQL은 진행 중인
     * transaction이나 새 transaction에서 적용한다. MySQL은 schema statement를 암묵적으로
     * commit하고, SQLite는 foreign key를 끈 채 table을 다시 만들어 column을 더하는데
     * foreign key 설정은 transaction 안에서 바뀌지 않으므로, 둘 다 transaction 밖에서
     * 적용하고 안에서는 CONFIG다.
     *
     * @return list<string> 만든 table은 "table", 더한 column은 "table.column", table 이름과 column 순서
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
        $apply = fn(?int $tx): array => $this->observed($tx, static function () use ($db, $pdo, $tx, $driver, $document, $documents): array {
            try {
                $live = self::introspectSet($pdo, $driver, $documents);
                [$added, $steps, $differences] = Dbspec::addTablesAndColumnsSteps($live->document, $live->unsupported, $document, $driver);
                if ($differences !== []) {
                    throw new OrmException(Code::SCHEMA_DIFFERS, 'the existing tables of the document set differ beyond missing tables, missing columns that are null or have a default and missing indexes: ' . implode('; ', $differences));
                }
                foreach ($steps as $step) {
                    // step은 그 effect의 table을 만들거나 바꾼다.
                    $db->run(StatementEvent::SCHEMA, $step->effect->table === '' ? [] : [$step->effect->table], $tx, $step->statement);
                }
                // step을 실행한 database가 set과 같은지 다시 읽어 확인한다.
                if ($steps !== []) {
                    $live = Dbspec::introspect($pdo, $driver, 'schema');
                }
                self::verifySet(Dbspec::installedDifferences($live->document, $live->unsupported, $document));
                return $added;
            } catch (\PDOException $e) {
                throw $db->driverError($e);
            }
        });
        if ($driver === 'postgres') {
            return $this->u->run(fn(): array => $apply($db->transactionNumber()));
        }
        if (Db::activeFor($this->db) !== null) {
            throw new OrmException(Code::CONFIG, "$driver adds tables and columns outside a transaction: MySQL commits schema statements implicitly and SQLite turns foreign keys off to rebuild a table");
        }
        if ($driver === 'mysql') {
            return $apply(null);
        }
        return $this->withoutForeignKeys($apply);
    }

    /**
     * $fn을 실행하는 동안 introspection의 catalog query마다 schema event를 publish한다.
     * catalog query는 table을 가리키지 않는다. $tx는 그 query의 transaction 번호다.
     *
     * @template T
     * @param \Closure(): T $fn
     * @return T
     */
    private function observed(?int $tx, \Closure $fn): mixed
    {
        $db = $this->db;
        return CatalogRows::observed(static function (string $query, int $start, ?\Throwable $failure) use ($db, $tx): void {
            $error = match (true) {
                $failure === null => null,
                $failure instanceof \PDOException => $db->driverError($failure),
                default => new OrmException(Code::DRIVER, $failure->getMessage(), $failure),
            };
            $db->publish(StatementEvent::SCHEMA, [], $tx, $query, [], $start, $error);
        }, $fn);
    }

    /**
     * 연결의 database를 introspect하고, set이 외부 문서에서 쓰는 table이 외부 문서와 다르면
     * CONFIG다(docs/dbspec.md "External documents").
     *
     * @param list<\Polyspec\Orm\Dbspec\Document> $documents
     */
    private static function introspectSet(\PDO $pdo, string $driver, array $documents): \Polyspec\Orm\Dbspec\IntrospectResult
    {
        $live = Dbspec::introspect($pdo, $driver, 'schema');
        $differences = Dbspec::externalDifferences($live->document, $documents);
        if ($differences !== []) {
            throw self::externalError($differences);
        }
        return $live;
    }

    /**
     * database가 set과 다르면 그 차이를 모두 담은 CONFIG다.
     *
     * @param list<string> $differences
     */
    private static function verifySet(array $differences): void
    {
        if ($differences !== []) {
            throw new OrmException(Code::CONFIG, 'the database differs from the document set: ' . implode('; ', $differences));
        }
    }

    /**
     * set의 schema text 문서다. database와 비교하는 대상이다. schema text는 외부 문서를 use
     * 줄로 쓰므로 외부 문서의 text를 집합으로 parse한다.
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
        $lines = array_map(static fn($d): string => "{$d->line}:{$d->column}: {$d->rule}: {$d->message}", $diagnostics);
        return new OrmException(Code::SCHEMA_INVALID, implode("\n", $lines));
    }

    /** @param list<string> $differences */
    private static function externalError(array $differences): OrmException
    {
        return new OrmException(Code::CONFIG, 'the tables that the set uses from external documents differ from the database: ' . implode('; ', $differences));
    }

    /**
     * SQLite 연결의 foreign key를 끄고 BEGIN IMMEDIATE transaction으로 `$fn`을 실행한
     * 뒤 foreign key 검사가 row를 돌려주지 않을 때만 commit하고 foreign key를 다시
     * 켠다(docs/plans.md "Apply"의 SQLite 다시 만들기).
     *
     * 이 transaction도 연결의 transaction 번호를 하나 받는다.
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
                $broken = (int) ($db->fetch(StatementEvent::SCHEMA, [], $tx, 'SELECT COUNT(*) FROM pragma_foreign_key_check')[0][0] ?? 0);
                if ($broken > 0) {
                    throw new OrmException(Code::INTERNAL, "the rebuilt tables break $broken foreign keys");
                }
            } catch (\Throwable $e) {
                // BEGIN 뒤 subscriber가 실패해도 transaction은 시작했으므로 driver의 상태로도 판단한다.
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
            'mysql' => $this->bool('SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)', [$schema]),
            default => $this->bool("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')", [str_replace('_', '\\_', $schema) . '\\_\\_%']),
        };
    }

    public function installed(string $schema, string $table): bool
    {
        $schema = self::name($schema);
        $table = self::name($table);
        return match ($this->db->driver()) {
            'postgres' => $this->bool('SELECT to_regclass($1) IS NOT NULL', [$schema . '.' . $table]),
            'mysql' => $this->bool('SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)', [$schema, $table]),
            default => $this->bool("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)", [$schema . '__' . $table]),
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
            'postgres' => $this->bool("SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))))", []),
            'mysql' => $this->bool('SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())', []),
            default => $this->bool("SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'orm\\_\\_%' ESCAPE '\\')", []),
        };
    }
}
