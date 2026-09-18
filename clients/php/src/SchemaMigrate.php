<?php
declare(strict_types=1);

namespace Orm;

/**
 * Applies a target schema to a live database: plans the SQL from the live
 * schema, records the migration in orm_schema_migrations and a JSON log,
 * executes it under a database lock, and verifies the result.
 */
final class SchemaMigrate
{
    public const TABLE = 'orm_schema_migrations';

    /**
     * Runs one migration and returns the result line.
     * @param array{migration_id: string, name: string, log_dir: string, dry_run: bool} $options
     */
    public static function run(\PDO $db, string $driver, array $want, array $options): string
    {
        $id = $options['migration_id'];
        self::ensureTable($db, $driver);
        try {
            $live = SchemaImport::liveManifest($db, $driver);
        } catch (\Throwable $e) {
            throw new \RuntimeException("MIGRATION_INTROSPECT: driver=$driver: " . $e->getMessage());
        }
        try {
            SchemaChecks::alignLive($db, $driver, $live, $want);
        } catch (\Throwable $e) {
            throw new \RuntimeException("MIGRATION_INTROSPECT: driver=$driver: " . $e->getMessage());
        }
        $previous = self::byId($db, $id);
        if ($previous !== null) {
            switch ($previous['status']) {
                case 'applied':
                    if ($previous['to'] !== $want['schema_hash']) {
                        throw new \RuntimeException("MIGRATION_HISTORY_CONFLICT: migration_id=$id recorded_to={$previous['to']} requested_to={$want['schema_hash']}");
                    }
                    if (!self::schemaMatches($want, $live, $driver)) {
                        throw new \RuntimeException("MIGRATION_DRIFT: migration_id=$id status=applied expected_schema_hash={$want['schema_hash']} actual_schema_hash={$live['schema_hash']}");
                    }
                    self::verifyLog($options['log_dir'], $previous, $driver);
                    return "migration_id=$id status=noop operations=0 schema_hash={$want['schema_hash']}\n";
                case 'retryable':
                    break;
                case 'queued':
                case 'applying':
                case 'failed':
                    throw new \RuntimeException("MIGRATION_RECOVERY_REQUIRED: migration_id=$id status={$previous['status']} run ormgen recover with --migration-id and the same target schema");
                default:
                    throw new \RuntimeException("MIGRATION_STATE_INVALID: migration_id=$id status={$previous['status']}");
            }
        }
        try {
            $sql = $live['entities'] === [] ? SchemaDdl::renderCreate($want, $driver) : SchemaDiff::render($live, $want, $driver, false);
        } catch (\RuntimeException $e) {
            throw new \RuntimeException("MIGRATION_PLAN: from={$live['schema_hash']} to={$want['schema_hash']}: " . $e->getMessage());
        }
        $operations = count(SchemaDdl::splitSql($sql));
        $checksum = hash('sha256', $sql);
        if ($previous !== null && ($previous['from'] !== $live['schema_hash'] || $previous['to'] !== $want['schema_hash'] || $previous['checksum'] !== $checksum || $previous['operations'] !== $operations)) {
            throw new \RuntimeException("MIGRATION_HISTORY_CONFLICT: migration_id=$id recorded_from={$previous['from']} requested_from={$live['schema_hash']} recorded_to={$previous['to']} requested_to={$want['schema_hash']} recorded_plan_checksum={$previous['checksum']} requested_plan_checksum=$checksum recorded_operations={$previous['operations']} requested_operations=$operations");
        }
        if ($options['dry_run']) {
            return "migration_id=$id status=planned from_schema_hash={$live['schema_hash']} to_schema_hash={$want['schema_hash']} operations=$operations\n$sql";
        }
        $record = ['id' => $id, 'name' => $options['name'], 'from' => $live['schema_hash'], 'to' => $want['schema_hash'], 'checksum' => $checksum, 'status' => 'queued', 'operations' => $operations];
        $started = self::now();
        self::writeLog($options['log_dir'], self::log($record, $driver, $started, null));
        $expected = 'queued';
        if ($previous !== null) {
            $expected = 'retryable';
        } else {
            try {
                self::insert($db, $record);
            } catch (\RuntimeException $e) {
                self::tryWriteLog($options['log_dir'], self::log($record, $driver, $started, self::now(), $e->getMessage()));
                throw $e;
            }
        }
        try {
            self::executeClaimed($db, $driver, $id, $expected, $sql);
        } catch (\RuntimeException $e) {
            $detail = 'operation execution failed: ' . $e->getMessage();
            try {
                self::markFailed($db, $id, $detail);
            } catch (\Throwable) {
            }
            self::tryWriteLog($options['log_dir'], self::log(['status' => 'failed'] + $record, $driver, $started, self::now(), $detail));
            throw new \RuntimeException("MIGRATION_APPLY_FAILED: migration_id=$id from={$live['schema_hash']} to={$want['schema_hash']}: " . $e->getMessage());
        }
        try {
            $check = SchemaImport::liveManifest($db, $driver);
        } catch (\Throwable $e) {
            self::quietly(static fn() => self::update($db, $id, 'failed', $e->getMessage()));
            throw new \RuntimeException("MIGRATION_VERIFY_FAILED: migration_id=$id: " . $e->getMessage());
        }
        if (!self::schemaMatches($want, $check, $driver)) {
            $detail = "expected {$want['schema_hash']} got {$check['schema_hash']}";
            self::quietly(static fn() => self::update($db, $id, 'failed', $detail));
            throw new \RuntimeException("MIGRATION_VERIFY_FAILED: migration_id=$id $detail");
        }
        try {
            self::update($db, $id, 'applied', '');
        } catch (\PDOException $e) {
            throw new \RuntimeException("MIGRATION_HISTORY_WRITE: migration_id=$id: " . $e->getMessage());
        }
        self::writeLog($options['log_dir'], self::log(['status' => 'applied'] + $record, $driver, $started, self::now()));
        return "migration_id=$id status=applied from_schema_hash={$live['schema_hash']} to_schema_hash={$want['schema_hash']} operations=$operations\n";
    }

    private static function ensureTable(\PDO $db, string $driver): void
    {
        $q = match ($driver) {
            'mysql' => 'CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamp NULL)',
            'postgres' => 'CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)',
            default => 'CREATE TABLE IF NOT EXISTS orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NULL)',
        };
        try {
            $db->exec($q);
        } catch (\PDOException $e) {
            throw new \RuntimeException("MIGRATION_HISTORY_CREATE: driver=$driver: " . $e->getMessage());
        }
    }

    /** @return array{id: string, name: string, from: string, to: string, checksum: string, status: string, operations: int}|null */
    public static function byId(\PDO $db, string $id): ?array
    {
        try {
            $st = $db->prepare('SELECT migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations FROM orm_schema_migrations WHERE migration_id=?');
            $st->execute([$id]);
            $row = $st->fetch(\PDO::FETCH_NUM);
        } catch (\PDOException $e) {
            throw new \RuntimeException("MIGRATION_HISTORY_READ: migration_id=$id: " . $e->getMessage());
        }
        if ($row === false) {
            return null;
        }
        return ['id' => $row[0], 'name' => $row[1], 'from' => $row[2], 'to' => $row[3], 'checksum' => $row[4], 'status' => $row[5], 'operations' => (int) $row[6]];
    }

    private static function insert(\PDO $db, array $r): void
    {
        try {
            $db->prepare("INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail) VALUES (?,?,?,?,?,?,?, '')")
                ->execute([$r['id'], $r['name'], $r['from'], $r['to'], $r['checksum'], $r['status'], $r['operations']]);
        } catch (\PDOException $e) {
            throw new \RuntimeException("MIGRATION_HISTORY_WRITE: migration_id={$r['id']}: " . $e->getMessage());
        }
    }

    private static function update(\PDO $db, string $id, string $status, string $detail): void
    {
        $db->prepare('UPDATE orm_schema_migrations SET status=?, error_detail=?, finished_at=CURRENT_TIMESTAMP WHERE migration_id=?')->execute([$status, $detail, $id]);
    }

    private static function transition(\PDO $db, string $id, string $from, string $to, string $detail): void
    {
        $q = 'UPDATE orm_schema_migrations SET status=?, error_detail=?'
            . ($to === 'applying' ? ', started_at=CURRENT_TIMESTAMP, finished_at=NULL' : ', finished_at=CURRENT_TIMESTAMP')
            . ' WHERE migration_id=? AND status=?';
        try {
            $st = $db->prepare($q);
            $st->execute([$to, $detail, $id, $from]);
        } catch (\PDOException $e) {
            throw new \RuntimeException("MIGRATION_HISTORY_WRITE: migration_id=$id transition={$from}_to_$to: " . $e->getMessage());
        }
        if ($st->rowCount() !== 1) {
            throw new \RuntimeException("MIGRATION_STATE_CHANGED: migration_id=$id expected_status=$from requested_status=$to affected_rows={$st->rowCount()}");
        }
    }

    private static function markFailed(\PDO $db, string $id, string $detail): void
    {
        try {
            $st = $db->prepare('UPDATE orm_schema_migrations SET status=?, error_detail=?, finished_at=CURRENT_TIMESTAMP WHERE migration_id=? AND status IN (?,?,?)');
            $st->execute(['failed', $detail, $id, 'queued', 'retryable', 'applying']);
        } catch (\PDOException $e) {
            throw new \RuntimeException("MIGRATION_HISTORY_WRITE: migration_id=$id mark_failed: " . $e->getMessage());
        }
        if ($st->rowCount() !== 1) {
            throw new \RuntimeException("MIGRATION_STATE_CHANGED: migration_id=$id failure status was not written affected_rows={$st->rowCount()}");
        }
    }

    /** Executes migration SQL under the migration lock, in one transaction where the database allows it. */
    public static function execute(\PDO $db, string $driver, string $sql): void
    {
        self::withLock($db, $driver, static fn() => self::statements($db, $driver, $sql));
    }

    private static function executeClaimed(\PDO $db, string $driver, string $id, string $expected, string $sql): void
    {
        self::withLock($db, $driver, static function () use ($db, $driver, $id, $expected, $sql): void {
            self::transition($db, $id, $expected, 'applying', '');
            self::statements($db, $driver, $sql);
        });
    }

    private static function statements(\PDO $db, string $driver, string $sql): void
    {
        if ($driver === 'sqlite') {
            self::preflightSqliteRebuild($db, $sql);
        }
        foreach (SchemaDdl::splitSql($sql) as $i => $stmt) {
            try {
                $db->exec($stmt);
            } catch (\PDOException $e) {
                throw new \RuntimeException(sprintf('operation=%d statement=%s: %s', $i + 1, Go::quote($stmt), $e->getMessage()));
            }
        }
        if ($driver === 'sqlite') {
            self::verifySqliteRebuild($db, $sql);
        }
    }

    /** @return list<array{table: string, target: string, temp: string}> */
    private static function rebuildMarkers(string $text): array
    {
        $markers = [];
        foreach (explode("\n", $text) as $line) {
            $line = SchemaParser::trim($line);
            $position = strpos($line, 'orm-sqlite-rebuild ');
            if ($position === false) {
                continue;
            }
            $values = [];
            $payload = trim(substr($line, $position + strlen('orm-sqlite-rebuild ')), "'\"; ");
            foreach (SchemaParser::fields($payload) as $field) {
                if (str_contains($field, '=')) {
                    [$key, $value] = explode('=', $field, 2);
                    $values[$key] = trim($value, "'\"; ");
                }
            }
            if (($values['table'] ?? '') !== '' && ($values['target'] ?? '') !== '' && ($values['temp'] ?? '') !== '') {
                $markers[] = ['table' => $values['table'], 'target' => $values['target'], 'temp' => $values['temp']];
            }
        }
        return $markers;
    }

    private static function preflightSqliteRebuild(\PDO $db, string $sql): void
    {
        $dropped = self::droppedTriggers($sql);
        foreach (self::rebuildMarkers($sql) as $m) {
            try {
                $st = $db->prepare('SELECT count(*) FROM sqlite_master WHERE name=?');
                $st->execute([$m['temp']]);
                $tempCount = (int) $st->fetchColumn();
            } catch (\PDOException $e) {
                throw new \RuntimeException("SQLITE_REBUILD_PREFLIGHT: table={$m['table']} temp={$m['temp']}: " . $e->getMessage());
            }
            if ($tempCount !== 0) {
                throw new \RuntimeException("SQLITE_REBUILD_UNSAFE: table={$m['table']} temporary object {$m['temp']} already exists");
            }
            try {
                $st = $db->prepare("SELECT type, name FROM sqlite_master WHERE (type='trigger' AND tbl_name=?) OR (type='view' AND lower(coalesce(sql,'')) LIKE ?) ORDER BY type, name");
                $st->execute([$m['table'], '%' . strtolower($m['table']) . '%']);
                $dependencies = [];
                foreach ($st->fetchAll(\PDO::FETCH_NUM) as [$kind, $name]) {
                    if ($kind === 'trigger' && isset($dropped[$name])) {
                        continue;
                    }
                    $dependencies[] = $kind . ':' . $name;
                }
            } catch (\PDOException $e) {
                throw new \RuntimeException("SQLITE_REBUILD_PREFLIGHT: table={$m['table']} dependencies: " . $e->getMessage());
            }
            if ($dependencies !== []) {
                throw new \RuntimeException("SQLITE_REBUILD_UNSAFE: table={$m['table']} dependent_objects=" . implode(',', $dependencies) . '; provide reviewed auxiliary migration SQL');
            }
            $violation = self::foreignKeyViolation($db, $m['table'], 'SQLITE_REBUILD_PREFLIGHT');
            if ($violation !== null) {
                throw new \RuntimeException("SQLITE_REBUILD_UNSAFE: $violation");
            }
        }
    }

    /**
     * The triggers a migration drops before it rebuilds a table; the rebuild
     * creates them again.
     * @return array<string, bool>
     */
    private static function droppedTriggers(string $sql): array
    {
        $dropped = [];
        foreach (SchemaDdl::splitSql($sql) as $statement) {
            if (str_starts_with($statement, 'DROP TRIGGER IF EXISTS ')) {
                $dropped[trim(substr($statement, strlen('DROP TRIGGER IF EXISTS ')), '"')] = true;
            }
        }
        return $dropped;
    }

    private static function verifySqliteRebuild(\PDO $db, string $sql): void
    {
        foreach (self::rebuildMarkers($sql) as $m) {
            $violation = self::foreignKeyViolation($db, $m['target'], 'SQLITE_REBUILD_VERIFY');
            if ($violation !== null) {
                throw new \RuntimeException("SQLITE_REBUILD_VERIFY: $violation");
            }
        }
    }

    private static function foreignKeyViolation(\PDO $db, string $table, string $code): ?string
    {
        try {
            $row = $db->query('PRAGMA foreign_key_check("' . str_replace('"', '""', $table) . '")')->fetch(\PDO::FETCH_NUM);
        } catch (\PDOException $e) {
            throw new \RuntimeException("$code: table=$table foreign_key_check: " . $e->getMessage());
        }
        if ($row === false) {
            return null;
        }
        $rowId = $row[1] === null ? '{0 false}' : '{' . $row[1] . ' true}';
        return "table={$row[0]} foreign_key_violation rowid=$rowId parent={$row[2]} foreign_key_id={$row[3]}";
    }

    private static function withLock(\PDO $db, string $driver, \Closure $run): void
    {
        $release = static function (): void {};
        switch ($driver) {
            case 'mysql':
                try {
                    $acquired = $db->query("SELECT GET_LOCK(CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60)), 0)")->fetchColumn();
                } catch (\PDOException $e) {
                    throw new \RuntimeException('MIGRATION_LOCK: mysql GET_LOCK: ' . $e->getMessage());
                }
                if ($acquired === null || (int) $acquired !== 1) {
                    throw new \RuntimeException('MIGRATION_LOCK_BUSY: mysql database migration lock was not acquired');
                }
                $release = static function () use ($db): void {
                    $released = $db->query("SELECT RELEASE_LOCK(CONCAT('orm:', LEFT(SHA2(DATABASE(), 256), 60)))")->fetchColumn();
                    if ($released === null || (int) $released !== 1) {
                        throw new \RuntimeException('mysql migration lock was not released');
                    }
                };
                try {
                    $db->exec('START TRANSACTION');
                } catch (\PDOException $e) {
                    self::quietly($release);
                    throw new \RuntimeException('transaction begin: ' . $e->getMessage());
                }
                break;
            case 'postgres':
                try {
                    $db->exec('BEGIN');
                } catch (\PDOException $e) {
                    throw new \RuntimeException('transaction begin: ' . $e->getMessage());
                }
                try {
                    $acquired = $db->query("SELECT pg_try_advisory_xact_lock(hashtext(current_database()), hashtext('polyspec.orm.migration'))")->fetchColumn();
                } catch (\PDOException $e) {
                    self::quietly(static fn() => $db->exec('ROLLBACK'));
                    throw new \RuntimeException('MIGRATION_LOCK: postgres advisory lock: ' . $e->getMessage());
                }
                if ($acquired !== true && $acquired !== 't' && $acquired !== 1) {
                    self::quietly(static fn() => $db->exec('ROLLBACK'));
                    throw new \RuntimeException('MIGRATION_LOCK_BUSY: postgres database migration lock was not acquired');
                }
                break;
            case 'sqlite':
                try {
                    $db->exec('BEGIN IMMEDIATE');
                } catch (\PDOException $e) {
                    throw new \RuntimeException('MIGRATION_LOCK_BUSY: sqlite BEGIN IMMEDIATE: ' . $e->getMessage());
                }
                break;
            default:
                throw new \RuntimeException('MIGRATION_CONFIG: unsupported driver ' . Go::quote($driver));
        }
        $failTx = static function (string $base) use ($db, $release): \RuntimeException {
            $rollbackError = self::quietly(static fn() => $db->exec('ROLLBACK'));
            $releaseError = self::quietly($release);
            if ($rollbackError !== null || $releaseError !== null) {
                return new \RuntimeException("$base; rollback_error=" . ($rollbackError ?? '<nil>') . '; lock_release_error=' . ($releaseError ?? '<nil>'));
            }
            return new \RuntimeException("$base; rollback issued");
        };
        try {
            $run();
        } catch (\RuntimeException $e) {
            throw $failTx($e->getMessage());
        }
        try {
            $db->exec('COMMIT');
        } catch (\PDOException $e) {
            throw $failTx('transaction commit: ' . $e->getMessage());
        }
        try {
            $release();
        } catch (\Throwable $e) {
            throw new \RuntimeException('MIGRATION_LOCK_RELEASE: ' . $e->getMessage());
        }
    }

    /** Runs a cleanup step and returns its error message, if any. */
    private static function quietly(\Closure $fn): ?string
    {
        try {
            $fn();
            return null;
        } catch (\Throwable $e) {
            return $e->getMessage();
        }
    }

    /**
     * Compares tables and columns by name. Column order is not a schema
     * property: a column added by a migration is appended by the database
     * wherever the declaration places it.
     */
    public static function schemaMatches(array $want, array $live, string $driver): bool
    {
        if (count($want['entities']) !== count($live['entities']) || !SchemaTriggers::same($want, $live)) {
            return false;
        }
        foreach ($want['entities'] as $name => $we) {
            $le = $live['entities'][$name] ?? null;
            if ($le === null || $we['table'] !== $le['table'] || $we['comment'] !== $le['comment'] || count($we['columns']) !== count($le['columns'])) {
                return false;
            }
            $liveColumns = array_column($le['columns'], null, 'name');
            foreach ($we['columns'] as $wc) {
                $lc = $liveColumns[$wc['name']] ?? null;
                if ($lc === null) {
                    return false;
                }
                $typeMatch = $driver === 'sqlite' ? SchemaDiff::sqliteTypeMatches($wc['type'], $lc['type']) : $wc['type'] === $lc['type'];
                if ($wc['comment'] !== $lc['comment'] || $wc['nullable'] !== $lc['nullable'] || !$typeMatch) {
                    return false;
                }
            }
        }
        return true;
    }

    public static function now(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
    }

    /** A UTC time in the RFC 3339 form with trailing fraction zeros removed. */
    private static function stamp(\DateTimeImmutable $t): string
    {
        $fraction = rtrim($t->format('u'), '0');
        return $t->format('Y-m-d\TH:i:s') . ($fraction !== '' ? '.' . $fraction : '') . 'Z';
    }

    public static function log(array $r, string $driver, \DateTimeImmutable $started, ?\DateTimeImmutable $finished, string $error = ''): array
    {
        $log = ['migration_id' => $r['id'], 'name' => $r['name'], 'driver' => $driver, 'from_schema_hash' => $r['from'], 'to_schema_hash' => $r['to'],
            'plan_checksum' => $r['checksum'], 'status' => $r['status'], 'operations' => $r['operations']];
        if ($error !== '') {
            $log['error_detail'] = $error;
        }
        $log['started_at'] = self::stamp($started);
        if ($finished !== null) {
            $log['finished_at'] = self::stamp($finished);
        }
        return $log;
    }

    private static function safeId(string $id): string
    {
        $out = preg_replace('/[^a-zA-Z0-9._-]/u', '_', $id);
        if ($out === null) {
            $out = preg_replace('/[^a-zA-Z0-9._-]/', '_', $id);
        }
        return $out === '' ? 'migration' : $out;
    }

    private static function tryWriteLog(string $dir, array $log): void
    {
        try {
            self::writeLog($dir, $log);
        } catch (\RuntimeException) {
        }
    }

    public static function writeLog(string $dir, array $log): void
    {
        if ($dir === '') {
            throw new \RuntimeException('MIGRATION_LOG_WRITE: log directory is empty');
        }
        if (!is_dir($dir) && !@mkdir($dir, 0o755, true) && !is_dir($dir)) {
            throw new \RuntimeException("MIGRATION_LOG_WRITE: mkdir $dir: " . (error_get_last()['message'] ?? 'failed'));
        }
        $tmp = @tempnam($dir, '.migration-');
        if ($tmp === false) {
            throw new \RuntimeException('MIGRATION_LOG_WRITE: create temporary file: ' . (error_get_last()['message'] ?? 'failed'));
        }
        $path = $dir . '/' . str_replace([':', '-'], '', $log['started_at']) . '__' . self::safeId($log['migration_id']) . '.json';
        if (@file_put_contents($tmp, Go::json($log, '  ') . "\n") === false || !@chmod($tmp, 0o644) || !@rename($tmp, $path)) {
            @unlink($tmp);
            throw new \RuntimeException("MIGRATION_LOG_WRITE: migration_id={$log['migration_id']}: " . (error_get_last()['message'] ?? 'failed'));
        }
    }

    public static function verifyLog(string $dir, array $r, string $driver): void
    {
        foreach (glob($dir . '/*__' . self::safeId($r['id']) . '.json') ?: [] as $path) {
            $text = @file_get_contents($path);
            if ($text === false) {
                throw new \RuntimeException("MIGRATION_LOG_READ: migration_id={$r['id']} file=$path: " . (error_get_last()['message'] ?? 'failed'));
            }
            $l = json_decode($text, true);
            if (!is_array($l)) {
                throw new \RuntimeException("MIGRATION_LOG_READ: migration_id={$r['id']} file=$path invalid JSON: " . json_last_error_msg());
            }
            if (($l['migration_id'] ?? '') === $r['id'] && ($l['driver'] ?? '') === $driver && ($l['from_schema_hash'] ?? '') === $r['from']
                && ($l['to_schema_hash'] ?? '') === $r['to'] && ($l['plan_checksum'] ?? '') === $r['checksum'] && ($l['status'] ?? '') === $r['status']
                && ($l['operations'] ?? null) === $r['operations']) {
                return;
            }
        }
        throw new \RuntimeException("MIGRATION_LOG_CONFLICT: migration_id={$r['id']} database record has no matching file log");
    }
}
