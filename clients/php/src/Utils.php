<?php
declare(strict_types=1);

namespace Orm;

use Orm\Dbspec\Dbspec;

/** Operations outside the query syntax: `$db->utils()`. */
final class Utils
{
    private readonly UtilsSql $sql;

    public function __construct(private readonly Db $db)
    {
        $this->sql = new UtilsSql($db);
    }

    private function active(string $name): TxFrame
    {
        return Db::activeFor($this->db) ?? throw new OrmException(Code::CONFIG, "$name requires an active transaction of the connection");
    }

    private static function validKey(string $key): bool
    {
        return strlen($key) <= 64 && preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.]*$/', $key) === 1;
    }

    private function driverError(\PDOException $e): OrmException|\Throwable
    {
        return OrmException::fromDriver($e, $this->db->driver());
    }

    /** Takes a named lock that is released when the transaction ends. */
    public function lock(string $key): void
    {
        $frame = $this->active('lock');
        if (!self::validKey($key)) {
            throw new OrmException(Code::CONFIG, "lock key $key is invalid");
        }
        $pdo = $this->db->pdo();
        try {
            switch ($this->db->driver()) {
                case 'mysql':
                    $st = $pdo->prepare('SELECT GET_LOCK(?, 50)');
                    $st->execute([$key]);
                    $got = $st->fetchColumn();
                    $st->closeCursor();
                    if ((int) $got !== 1) {
                        throw Orm::transactionConflict("lock $key was not acquired");
                    }
                    $frame->locks[] = $key;
                    break;
                case 'postgres':
                    $pdo->prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))')->execute([$key]);
                    break;
                default:
                    $this->db->acquireSQLiteRowLock('update');
            }
        } catch (\PDOException $e) {
            throw $this->driverError($e);
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
        $pdo = $this->db->pdo();
        try {
            switch ($this->db->driver()) {
                case 'postgres':
                    $pdo->prepare('SELECT set_config(?, ?, true)')->execute([$key, $value]);
                    break;
                case 'mysql':
                    $pdo->prepare('SET @`orm.' . $key . '` = ?')->execute([$value]);
                    break;
            }
        } catch (\PDOException $e) {
            throw $this->driverError($e);
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
        return new SchemaUtils($this->db, $this->sql);
    }

    public function privileges(): PrivilegeUtils
    {
        return new PrivilegeUtils($this->db, $this->sql);
    }

    public function aes(): AesUtils
    {
        return new AesUtils($this->db, $this->sql);
    }

    /** The connection state: one connection per Db in PHP. */
    public function stats(): Stats
    {
        $busy = Db::activeFor($this->db) !== null ? 1 : 0;
        return new Stats($this->db->poolSize(), 1, $busy, 1 - $busy);
    }
}

/** @internal statements of the utilities */
final class UtilsSql
{
    public function __construct(private readonly Db $db) {}

    /** Runs $fn in the active transaction of the connection or in a new one. */
    public function run(\Closure $fn): mixed
    {
        if (Db::activeFor($this->db) !== null) {
            return $fn();
        }
        return $this->db->transaction($fn, retry: 0);
    }

    private function driverError(\PDOException $e): OrmException|\Throwable
    {
        return OrmException::fromDriver($e, $this->db->driver());
    }

    public function scalar(string $sql, array $args): mixed
    {
        try {
            $st = $this->db->pdo()->prepare($sql);
            $st->execute($args);
            $v = $st->fetchColumn();
            $st->closeCursor();
            return $v;
        } catch (\PDOException $e) {
            throw $this->driverError($e);
        }
    }

    public function exec(string $sql, array $args = []): void
    {
        try {
            $this->db->pdo()->prepare($sql)->execute($args);
        } catch (\PDOException $e) {
            throw $this->driverError($e);
        }
    }
}

final readonly class Stats
{
    public function __construct(public int $maxOpenConnections, public int $openConnections, public int $inUse, public int $idle) {}
}

/** Schema installation and inspection. */
final class SchemaUtils
{
    public function __construct(private readonly Db $db, private readonly UtilsSql $sql) {}

    /**
     * dbspec document set을 connection의 database에 설치한다. client의
     * renderer가 만든 statement(docs/dialects.md "Rendered statements")로
     * table, key, index, foreign key, check, trigger를 만든다. $documents는
     * 집합의 각 문서 text다. 집합에 diagnostic이 있으면 SCHEMA_INVALID로
     * 실패한다. 집합의 table이 모두 있으면 아무것도 하지 않고, 일부만 있으면
     * CONFIG로 실패하므로 같은 집합의 반복 설치는 같은 상태를 남긴다. 있는
     * table의 정의는 비교하지 않는다. statement는 한 transaction에서 실행하며,
     * MySQL은 DDL마다 스스로 commit하므로 transaction 밖에서 실행한다.
     *
     * @param list<string> $documents
     */
    public function install(array $documents): void
    {
        $driver = $this->db->driver();
        $texts = [];
        foreach ($documents as $i => $text) {
            if (!is_string($text)) {
                throw new OrmException(Code::CONFIG, "document $i is not a dbspec text");
            }
            $texts["document $i"] = $text;
        }
        $parsed = RuntimeModel::parse($texts);
        $rendered = Dbspec::render($parsed, $driver);
        if ($rendered->statements === null) {
            $lines = array_map(static fn($d): string => "{$d->line}:{$d->column}: {$d->rule}: {$d->message}", $rendered->diagnostics);
            throw new OrmException(Code::SCHEMA_INVALID, implode("\n", $lines));
        }
        $statements = $rendered->statements;
        if ($statements === []) {
            throw new OrmException(Code::CONFIG, 'the document set has no tables');
        }
        $tables = [];
        foreach ($parsed as $document) {
            foreach ($document->tables as $table) {
                $tables[] = $table->name;
            }
        }
        $apply = function () use ($statements, $driver, $tables): void {
            $present = array_values(array_filter($tables, $this->tableExists(...)));
            if ($present === $tables) {
                return;
            }
            if ($present !== []) {
                throw new OrmException(Code::CONFIG, 'the database holds only some tables of the document set: ' . implode(', ', $present));
            }
            try {
                foreach ($statements as $statement) {
                    $this->db->pdo()->exec($statement);
                }
            } catch (\PDOException $e) {
                throw OrmException::fromDriver($e, $driver);
            }
        };
        if ($driver !== 'mysql') {
            $this->sql->run($apply);
            return;
        }
        if (Db::activeFor($this->db) !== null) {
            throw new OrmException(Code::CONFIG, 'MySQL commits schema statements implicitly; install outside a transaction');
        }
        $apply();
    }

    /** connection의 현재 database나 search_path에 table이 있는지 여부다. */
    private function tableExists(string $table): bool
    {
        return match ($this->db->driver()) {
            'postgres' => $this->bool('SELECT to_regclass(quote_ident(?)) IS NOT NULL', [$table]),
            'mysql' => $this->bool('SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?)', [$table]),
            default => $this->bool("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)", [$table]),
        };
    }

    private function bool(string $sql, array $args): bool
    {
        return (bool) $this->sql->scalar($sql, $args);
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
            'postgres' => $this->bool('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = ?)', [$schema]),
            'mysql' => $this->bool('SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)', [$schema]),
            default => $this->bool("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')", [str_replace('_', '\\_', $schema) . '\\_\\_%']),
        };
    }

    public function installed(string $schema, string $table): bool
    {
        $schema = self::name($schema);
        $table = self::name($table);
        return match ($this->db->driver()) {
            'postgres' => $this->bool('SELECT to_regclass(?) IS NOT NULL', [$schema . '.' . $table]),
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
    public function __construct(private readonly Db $db, private readonly UtilsSql $sql) {}

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
        $this->sql->run(function () use ($qualified, $r, $schema): void {
            $this->sql->exec("GRANT USAGE ON SCHEMA $schema TO $r");
            $this->sql->exec("GRANT SELECT, INSERT, UPDATE, DELETE ON $qualified TO $r");
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
        $this->sql->run(fn() => $this->sql->exec("REVOKE $privilege ON $qualified FROM $r"));
    }

    /** @return array{insert: bool, select: bool, update: bool, delete: bool, truncate: bool} */
    public function inspectTable(string $table): array
    {
        $qualified = $this->table($table);
        $out = [];
        foreach (['insert', 'select', 'update', 'delete', 'truncate'] as $p) {
            $out[$p] = (bool) $this->sql->scalar('SELECT has_table_privilege(current_user, ?, ?)', [$qualified, strtoupper($p)]);
        }
        return $out;
    }
}

/** AES key version status and rotation. */
final class AesUtils
{
    public function __construct(private readonly Db $db, private readonly UtilsSql $sql) {}

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
        try {
            $st = $this->db->pdo()->prepare("SELECT $version, COUNT(*) FROM {$this->q($spec['table'])} GROUP BY $version ORDER BY $version");
            $st->execute();
            $rows = $st->fetchAll(\PDO::FETCH_NUM);
            $st->closeCursor();
        } catch (\PDOException $e) {
            throw OrmException::fromDriver($e, $this->db->driver());
        }
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
        $columns = array_merge(array_map($this->q(...), $spec['keys']), [$this->q($spec['version'])], array_map(fn(array $c): string => $this->q($c['name']), $spec['columns']));
        $keyCount = count($spec['keys']);
        $select = 'SELECT ' . implode(', ', $columns) . " FROM {$this->q($spec['table'])} WHERE {$this->q($spec['version'])} <> ? ORDER BY " . implode(', ', array_slice($columns, 0, $keyCount)) . ' LIMIT 1000';
        $sets = array_map(fn(array $c): string => $this->q($c['name']) . ' = ?', $spec['columns']);
        $sets[] = $this->q($spec['version']) . ' = ?';
        $where = array_map(fn(string $k): string => $this->q($k) . ' = ?', $spec['keys']);
        $where[] = $this->q($spec['version']) . ' = ?';
        $update = "UPDATE {$this->q($spec['table'])} SET " . implode(', ', $sets) . ' WHERE ' . implode(' AND ', $where);
        return $this->sql->run(function () use ($select, $update, $spec, $keyring, $keyCount): int {
            $pdo = $this->db->pdo();
            $rotated = 0;
            try {
                while (true) {
                    $st = $pdo->prepare($select);
                    $st->execute([$keyring->currentVersion]);
                    $batch = $st->fetchAll(\PDO::FETCH_NUM);
                    $st->closeCursor();
                    if ($batch === []) {
                        return $rotated;
                    }
                    $up = $pdo->prepare($update);
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
                        foreach ($args as $i => $v) {
                            match (true) {
                                $v instanceof Bytes => $up->bindValue($i + 1, $v->bytes, \PDO::PARAM_LOB),
                                $v === null => $up->bindValue($i + 1, null, \PDO::PARAM_NULL),
                                is_int($v) => $up->bindValue($i + 1, $v, \PDO::PARAM_INT),
                                default => $up->bindValue($i + 1, (string) $v, \PDO::PARAM_STR),
                            };
                        }
                        $up->execute();
                        if ($up->rowCount() !== 1) {
                            throw Orm::transactionConflict("aes rotation of {$spec['table']} changed {$up->rowCount()} rows");
                        }
                        $rotated++;
                    }
                }
            } catch (\PDOException $e) {
                throw OrmException::fromDriver($e, $this->db->driver());
            }
        });
    }
}
