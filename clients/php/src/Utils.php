<?php
declare(strict_types=1);

namespace Orm;

use Orm\Dbspec\CatalogRows;
use Orm\Dbspec\Dbspec;
use Orm\Dbspec\DocumentSet;
use Orm\Dbspec\Renderer;

/** Operations outside the query syntax: `$db->utils()`. */
final class Utils
{
    public function __construct(private readonly Db $db) {}

    /**
     * @internal the active transaction of the connection; CONFIG names $name when there is none.
     * SchemaUtils, PrivilegeUtils and AesUtils reach the helpers through the Utils they hold.
     */
    public function active(string $name): TxFrame
    {
        return Db::activeFor($this->db) ?? throw new OrmException(Code::CONFIG, "$name requires an active transaction of the connection");
    }

    /** @internal runs $fn in the active transaction of the connection or in a new one without retry */
    public function run(\Closure $fn): mixed
    {
        if (Db::activeFor($this->db) !== null) {
            return $fn();
        }
        return $this->db->transaction($fn, retry: 0);
    }

    /**
     * @internal the first column of the first row of a statement, read through the active
     * transaction or the connection; false without a row. The statement publishes its event with
     * $kind and $tables.
     *
     * @param list<string> $tables
     */
    public function read(string $kind, array $tables, string $sql, array $args): mixed
    {
        $rows = $this->db->fetch($kind, $tables, $this->db->transactionNumber(), $sql, $args);
        return $rows === [] ? false : $rows[0][0];
    }

    /**
     * @internal runs a statement through the active transaction or the connection and publishes
     * its event with $kind and $tables
     *
     * @param list<string> $tables
     */
    public function exec(string $kind, array $tables, string $sql, array $args = []): void
    {
        $this->db->fetch($kind, $tables, $this->db->transactionNumber(), $sql, $args);
    }

    private static function validKey(string $key): bool
    {
        return strlen($key) <= 64 && preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.]*$/', $key) === 1;
    }

    /** Takes a named lock that is released when the transaction ends. */
    public function lock(string $key): void
    {
        $frame = $this->active('lock');
        if (!self::validKey($key)) {
            throw new OrmException(Code::CONFIG, "lock key $key is invalid");
        }
        switch ($this->db->driver()) {
            case 'mysql':
                $got = $this->db->fetch(StatementEvent::UTILITY, [], $frame->number, 'SELECT GET_LOCK(?, 50)', [$key])[0][0] ?? null;
                if ((int) $got !== 1) {
                    throw Orm::transactionConflict("lock $key was not acquired");
                }
                $frame->locks[] = $key;
                break;
            case 'postgres':
                $this->db->fetch(StatementEvent::UTILITY, [], $frame->number, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [$key]);
                break;
            default:
                $this->db->acquireSQLiteRowLock('update');
        }
    }

    /**
     * transaction-local 값을 정한다. PostgreSQL은 set_config, MySQL은 사용자
     * 변수에도 쓰며, SQLite는 transaction 안에서만 값을 가진다.
     */
    public function setLocal(string $key, string $value): void
    {
        $frame = $this->active('setLocal');
        if (!self::validKey($key)) {
            throw new OrmException(Code::CONFIG, "local key $key is invalid");
        }
        switch ($this->db->driver()) {
            case 'postgres':
                $this->db->fetch(StatementEvent::UTILITY, [], $frame->number, 'SELECT set_config($1, $2, true)', [$key, $value]);
                break;
            case 'mysql':
                $this->db->fetch(StatementEvent::UTILITY, [], $frame->number, 'SET @`orm.' . $key . '` = ?', [$value]);
                break;
        }
        $frame->locals[$key] = $value;
    }

    /** A value set with setLocal(); NO_ROWS when it is missing. */
    public function local(string $key): string
    {
        $frame = $this->active('local');
        return $frame->locals[$key] ?? throw new OrmException(Code::NO_ROWS, "local value $key is not set");
    }

    public function schema(): SchemaUtils
    {
        return new SchemaUtils($this->db, $this);
    }

    public function privileges(): PrivilegeUtils
    {
        return new PrivilegeUtils($this->db, $this);
    }

    public function aes(): AesUtils
    {
        return new AesUtils($this->db, $this);
    }

    /** The connection state: one connection per Db in PHP. */
    public function stats(): Stats
    {
        $busy = Db::activeFor($this->db) !== null ? 1 : 0;
        return new Stats(1, 1, $busy, 1 - $busy);
    }
}

final readonly class Stats
{
    public function __construct(public int $maxOpenConnections, public int $openConnections, public int $inUse, public int $idle) {}
}

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
     * @param list<\Orm\Dbspec\Document> $documents
     */
    private static function introspectSet(\PDO $pdo, string $driver, array $documents): \Orm\Dbspec\IntrospectResult
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
     * @param list<\Orm\Dbspec\Document> $documents
     */
    private static function target(array $documents): \Orm\Dbspec\Document
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

    /** @param list<\Orm\Dbspec\Diagnostic> $diagnostics */
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

/** Table privileges (PostgreSQL only). */
final class PrivilegeUtils
{
    public function __construct(private readonly Db $db, private readonly Utils $u) {}

    private function table(string $table): string
    {
        if ($this->db->driver() !== 'postgres') {
            throw new OrmException(Code::CAPABILITY_UNSUPPORTED, 'table privileges are supported only by postgres');
        }
        $parts = explode('.', $table);
        if (count($parts) !== 2 || preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $parts[0]) !== 1 || preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $parts[1]) !== 1) {
            throw new OrmException(Code::CONFIG, 'a qualified table name is required');
        }
        return '"' . $parts[0] . '"."' . $parts[1] . '"';
    }

    private static function role(string $role): string
    {
        if (preg_match('/^[A-Za-z_][A-Za-z0-9_.]*$/', $role) !== 1) {
            throw new OrmException(Code::CONFIG, "role $role is invalid");
        }
        return '"' . $role . '"';
    }

    public function grantTable(string $table, string $role): void
    {
        $qualified = $this->table($table);
        $r = self::role($role);
        $schema = substr($qualified, 0, (int) strpos($qualified, '.'));
        $this->u->run(function () use ($table, $qualified, $r, $schema): void {
            $this->u->exec(StatementEvent::UTILITY, [$table], "GRANT USAGE ON SCHEMA $schema TO $r");
            $this->u->exec(StatementEvent::UTILITY, [$table], "GRANT SELECT, INSERT, UPDATE, DELETE ON $qualified TO $r");
        });
    }

    public function revokeTable(string $table, string $privilege, string $role): void
    {
        $qualified = $this->table($table);
        $r = self::role($role);
        $privilege = strtoupper(trim($privilege));
        if (!in_array($privilege, ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'], true)) {
            throw new OrmException(Code::CONFIG, "unsupported table privilege $privilege");
        }
        $this->u->run(fn() => $this->u->exec(StatementEvent::UTILITY, [$table], "REVOKE $privilege ON $qualified FROM $r"));
    }

    /** @return array{insert: bool, select: bool, update: bool, delete: bool, truncate: bool} */
    public function inspectTable(string $table): array
    {
        $qualified = $this->table($table);
        // 다섯 권한을 statement 하나로 읽는다. 모든 client가 같은 statement를 실행한다.
        $row = $this->db->fetch(StatementEvent::UTILITY, [$table], $this->db->transactionNumber(), "SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')", [$qualified])[0];
        $out = [];
        foreach (['insert', 'select', 'update', 'delete', 'truncate'] as $i => $p) {
            $out[$p] = (bool) $row[$i];
        }
        return $out;
    }
}

/** AES key version status and rotation. */
final class AesUtils
{
    public function __construct(private readonly Db $db, private readonly Utils $u) {}

    /** @return array{table: string, keys: list<string>, version: string, columns: list<array{name: string, styles: list<string>}>} */
    private function spec(Model $model): array
    {
        $meta = $model::meta();
        $columns = [];
        foreach ($meta['columns'] as $name => $col) {
            if (RuntimeModel::encrypted($col)) {
                $columns[] = ['name' => $name, 'styles' => array_values(array_filter($col['codec'], static fn(string $s): bool => $s === 'aes' || $s === 'hex'))];
            }
        }
        if ($meta['aes_version'] === '' || $columns === []) {
            throw new OrmException(Code::CONFIG, "entity {$meta['entity']} has no AES columns with a key version");
        }
        return ['table' => $meta['table'], 'keys' => $meta['pk'], 'version' => $meta['aes_version'], 'columns' => $columns];
    }

    private function q(string $name): string
    {
        return $this->db->driver() === 'mysql' ? "`$name`" : "\"$name\"";
    }

    public function status(Model $model, AesKeyring $keyring): AesRotationStatus
    {
        $spec = $this->spec($model);
        $version = $this->q($spec['version']);
        $rows = $this->db->fetch(StatementEvent::UTILITY, [$spec['table']], $this->db->transactionNumber(), "SELECT $version, COUNT(*) FROM {$this->q($spec['table'])} GROUP BY $version ORDER BY $version");
        $versions = [];
        $total = 0;
        $pending = 0;
        foreach ($rows as [$stored, $count]) {
            $stored = (int) $stored;
            $count = (int) $count;
            $versions[$stored] = $count;
            $total += $count;
            if ($stored !== $keyring->currentVersion) {
                $pending += $count;
            }
        }
        return new AesRotationStatus($keyring->currentVersion, $total, $pending, $versions);
    }

    /** Re-encrypts every row that is not at the current key version, in one transaction. */
    public function rotate(Model $model, AesKeyring $keyring): int
    {
        $spec = $this->spec($model);
        $pg = $this->db->driver() === 'postgres';
        // PostgreSQL은 $n placeholder를 쓴다. pdo_pgsql에는 ?로 바꿔 보낸다.
        $ph = static fn(int $n): string => $pg ? '$' . $n : '?';
        $columns = array_merge(array_map($this->q(...), $spec['keys']), [$this->q($spec['version'])], array_map(fn(array $c): string => $this->q($c['name']), $spec['columns']));
        $keyCount = count($spec['keys']);
        $select = 'SELECT ' . implode(', ', $columns) . " FROM {$this->q($spec['table'])} WHERE {$this->q($spec['version'])} <> {$ph(1)} ORDER BY " . implode(', ', array_slice($columns, 0, $keyCount)) . ' LIMIT 1000';
        $sets = [];
        foreach ($spec['columns'] as $i => $c) {
            $sets[] = $this->q($c['name']) . ' = ' . $ph($i + 1);
        }
        $sets[] = $this->q($spec['version']) . ' = ' . $ph(count($spec['columns']) + 1);
        $where = [];
        foreach ($spec['keys'] as $i => $k) {
            $where[] = $this->q($k) . ' = ' . $ph(count($spec['columns']) + 2 + $i);
        }
        $where[] = $this->q($spec['version']) . ' = ' . $ph(count($spec['columns']) + 2 + $keyCount);
        $update = "UPDATE {$this->q($spec['table'])} SET " . implode(', ', $sets) . ' WHERE ' . implode(' AND ', $where);
        return $this->u->run(function () use ($select, $update, $spec, $keyring, $keyCount, $pg): int {
            $db = $this->db;
            $tx = $db->transactionNumber();
            $tables = [$spec['table']];
            $rotated = 0;
            try {
                $up = $db->pdo()->prepare($pg ? preg_replace('/\$\d+/', '?', $update) : $update);
            } catch (\PDOException $e) {
                throw $db->driverError($e);
            }
            while (true) {
                $batch = $db->fetch(StatementEvent::UTILITY, $tables, $tx, $select, [$keyring->currentVersion]);
                if ($batch === []) {
                    return $rotated;
                }
                foreach ($batch as $values) {
                    $row = [];
                    foreach ($spec['keys'] as $i => $k) {
                        $row[$k] = $values[$i];
                    }
                    $version = (int) $values[$keyCount];
                    $row[$spec['version']] = $version;
                    foreach ($spec['columns'] as $i => $c) {
                        $row[$c['name']] = $values[$keyCount + 1 + $i];
                    }
                    $after = $keyring->rotateRow($row, $spec['version'], $spec['columns'], $keyring->currentVersion);
                    $args = [];
                    foreach ($spec['columns'] as $c) {
                        $args[] = $after[$c['name']];
                    }
                    $args[] = $keyring->currentVersion;
                    foreach ($spec['keys'] as $k) {
                        $args[] = $row[$k];
                    }
                    $args[] = $version;
                    $changed = $db->observed(StatementEvent::UTILITY, $tables, $tx, $update, $args, static function () use ($up, $args): int {
                        foreach ($args as $i => $v) {
                            match (true) {
                                $v instanceof Bytes => $up->bindValue($i + 1, $v->bytes, \PDO::PARAM_LOB),
                                $v === null => $up->bindValue($i + 1, null, \PDO::PARAM_NULL),
                                is_int($v) => $up->bindValue($i + 1, $v, \PDO::PARAM_INT),
                                default => $up->bindValue($i + 1, (string) $v, \PDO::PARAM_STR),
                            };
                        }
                        $up->execute();
                        return $up->rowCount();
                    });
                    if ($changed !== 1) {
                        throw Orm::transactionConflict("aes rotation of {$spec['table']} changed $changed rows");
                    }
                    $rotated++;
                }
            }
        });
    }
}
