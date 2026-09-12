<?php
declare(strict_types=1);

namespace Orm;

/**
 * Process-wide configuration. Everything is declared (absolute paths, keys);
 * nothing is discovered or polled.
 */
final class Orm
{
    private static ?Config $config = null;
    private static ?Transport $transport = null;

    /**
     * Installs the configuration and checks the schema hash exactly once: the generated
     * bootstrap's hash (Registry) must equal schema.json's and the one ormd loaded.
     * No watching, no reload — a mismatch is SCHEMA_HASH_MISMATCH here and nowhere else.
     */
    public static function init(Config $config): void
    {
        self::$config = $config;
        self::$transport = null;
        $generated = Registry::schemaHash();
        $file = $config->schemaHash();
        if ($file !== $generated) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "generated code is from $generated, {$config->schemaPath} is $file");
        }
        $daemon = self::transport()->info();
        if ($daemon['schema_hash'] !== $generated) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "generated code is from $generated, compiler at {$config->compilerLocation()} loaded {$daemon['schema_hash']}");
        }
        // The plans are dialect text (docs/dialects.md): ormd must compile for the database the PDO driver speaks.
        if ($daemon['dialect'] !== $config->driver) {
            throw new OrmException(Code::CONFIG, "compiler at {$config->compilerLocation()} compiles for {$daemon['dialect']} but the driver is {$config->driver}");
        }
        if (($daemon['ir_version'] ?? 1) !== 1) {
            throw new OrmException(Code::VERSION_MISMATCH, "client IR version 1 but compiler uses {$daemon['ir_version']}");
        }
    }

    /**
     * Loads orm.toml (docs/config.md), installs it with init() and opens the database.
     * `[db].driver` (mysql, the default | postgres | sqlite) selects the PDO driver; ormd must run with
     * the same `-dialect`. Paths must be absolute, exist and not be symlinks; anything else is CONFIG.
     */
    public static function fromConfig(string $path): Db
    {
        $cfg = Toml::parseFile($path);
        // docs/config.md is the whole vocabulary; a key outside it is a typo, not an extension (strict, like Go).
        $known = ['schema' => true, 'db' => ['driver', 'dsn', 'user', 'password', 'pool', 'plan_cache_size', 'statement_cache_size'], 'secrets' => ['aes', 'aes_env', 'aes_keys', 'aes_version', 'blind_index', 'blind_index_env'], 'engine' => ['wasm', 'cache_dir'], 'ormd' => ['endpoint', 'timeout_ms', 'socket'], 'debug' => ['on_query']];
        foreach ($cfg as $k => $v) {
            if (!isset($known[$k])) {
                throw new OrmException(Code::CONFIG, "$path: unknown key $k");
            }
            if (is_array($known[$k])) {
                foreach (array_keys(is_array($v) ? $v : []) as $sub) {
                    if (!in_array($sub, $known[$k], true)) {
                        throw new OrmException(Code::CONFIG, "$path: unknown key $k.$sub");
                    }
                }
            }
        }
        $schemaPath = self::pathOf($cfg, '', 'schema');
        $ormd = $cfg['ormd'] ?? [];
        $endpoint = $ormd['endpoint'] ?? null;
        if ($endpoint !== null && !is_string($endpoint)) {
            throw new OrmException(Code::CONFIG, "$path: ormd.endpoint must be a string");
        }
        $timeoutMs = $ormd['timeout_ms'] ?? 5000;
        if (!is_int($timeoutMs) || $timeoutMs <= 0) {
            throw new OrmException(Code::CONFIG, "$path: ormd.timeout_ms must be a positive integer");
        }
        $socket = $endpoint === null ? self::pathOf($cfg, 'ormd', 'socket') : (is_string($ormd['socket'] ?? null) ? $ormd['socket'] : '/unused');
        $db = $cfg['db'] ?? throw new OrmException(Code::CONFIG, "$path: [db] is required");
        $driver = $db['driver'] ?? 'mysql';
        if (!in_array($driver, Db::DRIVERS, true)) {
            throw new OrmException(Code::CONFIG, "$path: db.driver must be mysql, postgres or sqlite");
        }
        $dsn = $db['dsn'] ?? throw new OrmException(Code::CONFIG, "$path: db.dsn is required");
        $user = $db['user'] ?? null;
        $password = $db['password'] ?? null;
		$planCacheSize = $db['plan_cache_size'] ?? 256;
		$statementCacheSize = $db['statement_cache_size'] ?? 256;
		if (!is_int($planCacheSize) || $planCacheSize < 1 || !is_int($statementCacheSize) || $statementCacheSize < 1) {
			throw new OrmException(Code::CONFIG, "$path: db cache sizes must be positive integers");
		}
        if (!is_string($dsn) || ($user !== null && !is_string($user)) || ($password !== null && !is_string($password))) {
            throw new OrmException(Code::CONFIG, "$path: db.dsn, db.user and db.password must be strings");
        }
        if ($driver === 'sqlite') {
            // db.dsn is the database file; SQLite has no credentials.
            if ($user !== null || $password !== null) {
                throw new OrmException(Code::CONFIG, "$path: db.user and db.password do not apply to sqlite");
            }
            $dsn = self::pathOf($cfg, 'db', 'dsn');
        } else {
            // [db].user/password apply only when the DSN carries none (PDO accepts user=/password= keys); a conflict is CONFIG.
            $inDsn = self::dsnCredentials($dsn);
            if (isset($inDsn['user'])) {
                if ($user !== null && $user !== $inDsn['user']) {
                    throw new OrmException(Code::CONFIG, "$path: db.user ($user) conflicts with the user in db.dsn ({$inDsn['user']})");
                }
                $user = $inDsn['user'];
            } elseif ($user === null) {
                throw new OrmException(Code::CONFIG, "$path: db.user is required (the DSN names no user)");
            }
            $password ??= $inDsn['password'] ?? '';
        }
        $secrets = $cfg['secrets'] ?? [];
        $aesKey = '';
        $blindIndexKey = '';
        $aesVersion = 1;
        $aesKeys = [];
        if (isset($secrets['aes'], $secrets['aes_env'])) {
            throw new OrmException(Code::CONFIG, "$path: secrets.aes and secrets.aes_env are exclusive");
        }
        if (isset($secrets['aes'])) {
            $aesKey = $secrets['aes'];
        } elseif (isset($secrets['aes_env'])) {
            $aesKey = (string) getenv((string) $secrets['aes_env']);
            if ($aesKey === '') {
                throw new OrmException(Code::CONFIG, "$path: environment variable {$secrets['aes_env']} (secrets.aes_env) is empty");
            }
        }
        if (!is_string($aesKey)) {
            throw new OrmException(Code::CONFIG, "$path: secrets.aes must be a string");
        }
        if (isset($secrets['blind_index'], $secrets['blind_index_env'])) {
            throw new OrmException(Code::CONFIG, "$path: secrets.blind_index and secrets.blind_index_env are exclusive");
        }
        if (isset($secrets['blind_index'])) {
            if (!is_string($secrets['blind_index']) || $secrets['blind_index'] === '') throw new OrmException(Code::CONFIG, "$path: secrets.blind_index must be a non-empty string");
            $blindIndexKey = $secrets['blind_index'];
        } elseif (isset($secrets['blind_index_env'])) {
            $blindIndexKey = (string) getenv((string) $secrets['blind_index_env']);
            if ($blindIndexKey === '') throw new OrmException(Code::CONFIG, "$path: environment variable {$secrets['blind_index_env']} (secrets.blind_index_env) is empty");
        }
        if (isset($secrets['aes_keys'])) {
            if (isset($secrets['aes']) || isset($secrets['aes_env']) || !is_array($secrets['aes_keys'])) {
                throw new OrmException(Code::CONFIG, "$path: secrets.aes_keys is exclusive with secrets.aes and secrets.aes_env");
            }
            $aesVersion = $secrets['aes_version'] ?? throw new OrmException(Code::CONFIG, "$path: secrets.aes_version is required with secrets.aes_keys");
            if (!is_int($aesVersion) || $aesVersion < 1) {
                throw new OrmException(Code::CONFIG, "$path: secrets.aes_version must be a positive integer");
            }
            $keys = [];
            foreach ($secrets['aes_keys'] as $version => $key) {
                if ((!is_int($version) && !ctype_digit((string) $version)) || (int) $version < 1 || !is_string($key) || $key === '') {
                    throw new OrmException(Code::CONFIG, "$path: invalid secrets.aes_keys entry");
                }
                $keys[(int) $version] = $key;
            }
            $keyring = new AesKeyring($keys, $aesVersion);
            $aesKey = $keys[$keyring->currentVersion];
            $aesKeys = $keys;
        } elseif (isset($secrets['aes_version']) && $secrets['aes_version'] !== 1) {
            throw new OrmException(Code::CONFIG, "$path: secrets.aes_version requires secrets.aes_keys");
        }
        $onQuery = null;
        if (($cfg['debug']['on_query'] ?? false) === true) {
            $onQuery = static function (string $sql, array $binds, float $seconds, string $planId, ?\Throwable $err): void {
                error_log(sprintf('orm %s %.3fms %s %s%s', $planId, $seconds * 1000, $sql,
                    json_encode($binds, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), $err === null ? '' : ' ! ' . $err->getMessage()));
            };
        }
        $config = new Config(socket: $socket, schemaPath: $schemaPath, aesKey: $aesKey, blindIndexKey: $blindIndexKey, aesVersion: $aesVersion, aesKeys: $aesKeys, onQuery: $onQuery, driver: $driver, endpoint: $endpoint, timeoutSeconds: $timeoutMs / 1000, planCacheSize: $planCacheSize, statementCacheSize: $statementCacheSize);
        if ($aesKey === '' && $config->hasSecretColumns()) {
            throw new OrmException(Code::CONFIG, "$path: the schema has aes columns; secrets.aes or secrets.aes_env is required");
        }
        if ($blindIndexKey === '' && $config->hasBlindIndexColumns()) {
            throw new OrmException(Code::CONFIG, "$path: the schema has blind indexes; secrets.blind_index or secrets.blind_index_env is required");
        }
        self::init($config);
        return match ($driver) {
            'mysql' => Db::mysql($dsn, $user, $password),
            'postgres' => Db::postgres($dsn, $user, $password),
            'sqlite' => Db::sqlite($dsn),
        };
    }

    /** @return array{user?: string, password?: string} the user=/password= keys of a PDO DSN */
    private static function dsnCredentials(string $dsn): array
    {
        $out = [];
        foreach (explode(';', substr($dsn, (int) strpos($dsn, ':') + 1)) as $kv) {
            $eq = strpos($kv, '=');
            if ($eq === false) {
                continue;
            }
            $k = trim(substr($kv, 0, $eq));
            if ($k === 'user' || $k === 'password') {
                $out[$k] = trim(substr($kv, $eq + 1));
            }
        }
        return $out;
    }

    private static function pathOf(array $cfg, string $table, string $key): string
    {
        $where = $table === '' ? $key : "$table.$key";
        $v = $table === '' ? ($cfg[$key] ?? null) : ($cfg[$table][$key] ?? null);
        if (!is_string($v) || $v === '') {
            throw new OrmException(Code::CONFIG, "$where is required");
        }
        if (!str_starts_with($v, '/')) {
            throw new OrmException(Code::CONFIG, "$where must be an absolute path: $v");
        }
        if (is_link($v)) {
            throw new OrmException(Code::CONFIG, "$where must not be a symlink: $v");
        }
        if (!file_exists($v)) {
            throw new OrmException(Code::CONFIG, "$where does not exist: $v");
        }
        return $v;
    }

    public static function config(): Config
    {
        if (self::$config === null) {
            throw new OrmException(Code::CONFIG, 'Orm::init(Config) must be called first');
        }
        return self::$config;
    }

    public static function transport(): Transport
    {
        if (self::$transport === null) {
            self::$transport = new Transport(self::config());
        }
        return self::$transport;
    }
}

final class Config
{
    public function __construct(
        /** absolute path of the ormd unix socket */
        public readonly string $socket,
        /** absolute path of schema.json (its schema_hash is read once) */
        public readonly string $schemaPath,
        /** secret "aes" for aes/aes_hex columns */
        public readonly string $aesKey = '',
        /** stable secret "blind_index" for encrypted equality indexes */
        public readonly string $blindIndexKey = '',
        /** version stored in aes_key_version with new AES values */
        public readonly int $aesVersion = 1,
        /** @var array<int,string> all declared versions for mixed-version reads */
        public readonly array $aesKeys = [],
        /**
         * called for every executed statement:
         * fn(string $sql, array $binds, float $seconds, string $planId, ?\Throwable $err)
         * — binds have secret slots masked as "$SECRET"; $planId is the plan cache key suffix (same for every statement of one shape)
         */
        public readonly ?\Closure $onQuery = null,
        /** the database the Db speaks (mysql | postgres | sqlite); ormd must compile for the same dialect */
        public readonly string $driver = 'mysql',
        /** Connect compiler endpoint. */
        public readonly ?string $endpoint = null,
        /** Compiler request timeout in seconds. */
        public readonly float $timeoutSeconds = 5.0,
        public readonly int $planCacheSize = 256,
        public readonly int $statementCacheSize = 256,
    ) {
        if (!str_starts_with($schemaPath, '/')) {
            throw new OrmException(Code::CONFIG, 'schemaPath must be absolute');
        }
        if ($endpoint === null && !str_starts_with($socket, '/')) {
            throw new OrmException(Code::CONFIG, 'socket must be absolute');
        }
        if (!in_array($driver, Db::DRIVERS, true)) {
            throw new OrmException(Code::CONFIG, "driver $driver: want mysql, postgres or sqlite");
        }
        if ($endpoint !== null && !preg_match('#^https?://#', $endpoint)) {
            throw new OrmException(Code::CONFIG, 'compiler endpoint must use http:// or https://');
        }
        if ($timeoutSeconds <= 0) {
            throw new OrmException(Code::CONFIG, 'compiler timeout must be positive');
        }
        if ($aesVersion < 1) {
            throw new OrmException(Code::CONFIG, 'aesVersion must be positive');
        }
		if ($planCacheSize < 1 || $statementCacheSize < 1) {
			throw new OrmException(Code::CONFIG, 'cache sizes must be positive');
		}
    }

    private ?array $manifest = null;
    private ?string $hash = null;

    public function compilerLocation(): string
    {
        return $this->endpoint ?? $this->socket;
    }

    private function manifest(): array
    {
        if ($this->manifest === null) {
            $js = file_get_contents($this->schemaPath);
            if ($js === false) {
                throw new OrmException(Code::CONFIG, "cannot read {$this->schemaPath}");
            }
            $m = json_decode($js, true);
            if (!is_array($m) || !isset($m['schema_hash'])) {
                throw new OrmException(Code::SCHEMA_INVALID, "no schema_hash in {$this->schemaPath}");
            }
            $this->manifest = $m;
        }
        return $this->manifest;
    }

    public function schemaHash(): string
    {
        return $this->hash ??= (string) $this->manifest()['schema_hash'];
    }

    /** Whether any column of the manifest carries the aes style (then a secret must be configured). */
    public function hasSecretColumns(): bool
    {
        foreach ($this->manifest()['entities'] ?? [] as $e) {
            foreach ($e['columns'] ?? [] as $c) {
                if (in_array('aes', $c['styles'] ?? [], true)) {
                    return true;
                }
            }
        }
        return false;
    }

    private function hasBlindIndexColumns(): bool
    {
        foreach ($this->manifest()['entities'] ?? [] as $e) foreach ($e['columns'] ?? [] as $c) if (($c['blind_index'] ?? '') !== '') return true;
        return false;
    }
}

final class OrmException extends \RuntimeException
{
    public function __construct(public readonly string $code_, string $message, ?\Throwable $previous = null)
    {
        parent::__construct($code_ . ': ' . $message, 0, $previous);
    }

    /**
     * The driver errors docs/errors.yaml maps to a code, per driver:
     * MySQL 1213 / SQLSTATE 40001 → DEADLOCK, 1062 → DUPLICATE_KEY, 1451/1452 → FOREIGN_KEY;
     * PostgreSQL SQLSTATE 40P01 (deadlock_detected) / 40001 (serialization_failure) → DEADLOCK, 23505 (unique_violation) → DUPLICATE_KEY, 23503 → FOREIGN_KEY;
     * SQLite 5 / 6 (SQLITE_BUSY / SQLITE_LOCKED: the other writer wins, re-run) and their extended forms 261 / 262 → DEADLOCK,
     * SQLITE_CONSTRAINT_UNIQUE 2067 / _PRIMARYKEY 1555 → DUPLICATE_KEY — pdo_sqlite reports the primary code 19 with the
     * message "UNIQUE constraint failed: …", which is mapped the same way.
     * Every other driver error is returned unchanged; the driver's message is kept in the OrmException text.
     */
    public static function fromDriver(\PDOException $e, string $driver = 'mysql'): \Throwable
    {
        $state = (string) ($e->errorInfo[0] ?? $e->getCode());
        $num = $e->errorInfo[1] ?? null;
        switch ($driver) {
            case 'postgres':
                if ($state === '40P01' || $state === '40001') {
                    return new self(Code::DEADLOCK, $e->getMessage(), $e);
                }
                if ($state === '23505') {
                    return new self(Code::DUPLICATE_KEY, $e->getMessage(), $e);
                }
                if ($state === '23503') {
                    return new self(Code::FOREIGN_KEY, $e->getMessage(), $e);
                }
                return $e;
            case 'sqlite':
                if ($num === 5 || $num === 6 || $num === 261 || $num === 262) {
                    return new self(Code::DEADLOCK, $e->getMessage(), $e);
                }
                if ($num === 2067 || $num === 1555 || ($num === 19 && str_starts_with((string) ($e->errorInfo[2] ?? ''), 'UNIQUE constraint failed'))) {
                    return new self(Code::DUPLICATE_KEY, $e->getMessage(), $e);
                }
                if ($num === 787 || $num === 1811 || ($num === 19 && str_starts_with((string) ($e->errorInfo[2] ?? ''), 'FOREIGN KEY constraint failed'))) {
                    return new self(Code::FOREIGN_KEY, $e->getMessage(), $e);
                }
                return $e;
        }
        if ($num === 1213 || $state === '40001') {
            return new self(Code::DEADLOCK, $e->getMessage(), $e);
        }
        if ($num === 1062 || ($num === null && $state === '23000')) {
            return new self(Code::DUPLICATE_KEY, $e->getMessage(), $e);
        }
        if ($num === 1451 || $num === 1452) {
            return new self(Code::FOREIGN_KEY, $e->getMessage(), $e);
        }
        return $e;
    }
}
