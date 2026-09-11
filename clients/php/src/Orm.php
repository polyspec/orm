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
        $daemon = self::transport()->hash();
        if ($daemon !== $generated) {
            throw new OrmException(Code::SCHEMA_HASH_MISMATCH, "generated code is from $generated, ormd at {$config->socket} loaded $daemon");
        }
    }

    /**
     * Loads orm.toml (docs/config.md), installs it with init() and opens the database.
     * Paths must be absolute, exist and not be symlinks; anything else is CONFIG.
     */
    public static function fromConfig(string $path): Db
    {
        $cfg = Toml::parseFile($path);
        $schemaPath = self::pathOf($cfg, '', 'schema');
        $socket = self::pathOf($cfg, 'ormd', 'socket');
        $db = $cfg['db'] ?? throw new OrmException(Code::CONFIG, "$path: [db] is required");
        $dsn = $db['dsn'] ?? throw new OrmException(Code::CONFIG, "$path: db.dsn is required");
        $user = $db['user'] ?? null;
        $password = $db['password'] ?? null;
        if (!is_string($dsn) || ($user !== null && !is_string($user)) || ($password !== null && !is_string($password))) {
            throw new OrmException(Code::CONFIG, "$path: db.dsn, db.user and db.password must be strings");
        }
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
        $secrets = $cfg['secrets'] ?? [];
        $aesKey = '';
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
        $onQuery = null;
        if (($cfg['debug']['on_query'] ?? false) === true) {
            $onQuery = static function (string $sql, array $binds, float $seconds, string $planId, ?\Throwable $err): void {
                error_log(sprintf('orm %s %.3fms %s %s%s', $planId, $seconds * 1000, $sql,
                    json_encode($binds, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), $err === null ? '' : ' ! ' . $err->getMessage()));
            };
        }
        $config = new Config(socket: $socket, schemaPath: $schemaPath, aesKey: $aesKey, onQuery: $onQuery);
        if ($aesKey === '' && $config->hasSecretColumns()) {
            throw new OrmException(Code::CONFIG, "$path: the schema has aes columns; secrets.aes or secrets.aes_env is required");
        }
        self::init($config);
        return Db::mysql($dsn, $user, $password);
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
        /**
         * called for every executed statement:
         * fn(string $sql, array $binds, float $seconds, string $planId, ?\Throwable $err)
         * — binds have secret slots masked as "$SECRET"; $planId is the plan cache key suffix (same for every statement of one shape)
         */
        public readonly ?\Closure $onQuery = null,
    ) {
        if (!str_starts_with($socket, '/') || !str_starts_with($schemaPath, '/')) {
            throw new OrmException(Code::CONFIG, 'socket and schemaPath must be absolute');
        }
    }

    private ?array $manifest = null;
    private ?string $hash = null;

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
}

final class OrmException extends \RuntimeException
{
    public function __construct(public readonly string $code_, string $message, ?\Throwable $previous = null)
    {
        parent::__construct($code_ . ': ' . $message, 0, $previous);
    }

    /**
     * The driver errors docs/errors.yaml maps to a code: MySQL 1213 / SQLSTATE 40001 → DEADLOCK,
     * MySQL 1062 (or SQLSTATE 23000 without a driver code) → DUPLICATE_KEY. Every other driver
     * error is returned unchanged; the driver's message is kept in the OrmException text.
     */
    public static function fromDriver(\PDOException $e): \Throwable
    {
        $state = (string) ($e->errorInfo[0] ?? $e->getCode());
        $num = $e->errorInfo[1] ?? null;
        if ($num === 1213 || $state === '40001') {
            return new self(Code::DEADLOCK, $e->getMessage(), $e);
        }
        if ($num === 1062 || ($num === null && $state === '23000')) {
            return new self(Code::DUPLICATE_KEY, $e->getMessage(), $e);
        }
        return $e;
    }
}
