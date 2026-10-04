<?php
declare(strict_types=1);

namespace Orm;

/** Opens connections and creates ORM function values. */
final class Orm
{
    /** milliseconds a SQLite connection waits for a lock when the DSN sets no _pragma=busy_timeout(ms) */
    private const SQLITE_BUSY_TIMEOUT_MS = 5000;

    /** scheme마다 DSN이 받는 parameter다(docs/config.md). 다른 parameter는 CONFIG다. */
    private const DSN_PARAMETERS = [
        'mysql' => ['timezone', 'socket', 'ssl-mode', 'ssl-ca'],
        'postgres' => ['timezone', 'host', 'sslmode'],
        'sqlite' => ['timezone', '_pragma', '_txlock'],
    ];

    /**
     * DSN URI(mysql://, postgres://, sqlite://)가 고르는 database를 열고 generated
     * schema의 set을 utils()->schema()->register처럼 그 연결에 등록한다. generated code의
     * connect helper가 부른다. text가 선언한 hash로 hash되지 않으면 연결을 열기 전에
     * CONFIG다. 등록은 database를 읽지 않는다: database는 install과 addTablesAndColumns가
     * 확인한다.
     */
    public static function connectSchema(string $dsn, Schema $schema, Config $config): Db
    {
        $schema->verify();
        $db = self::connect($dsn, $config);
        $db->registerSet($schema);
        return $db;
    }

    /**
     * DSN URI(mysql://, postgres://, sqlite://)가 고르는 database를 연다. 연결에는
     * 등록된 set이 없으므로 model 요청은 install이 그 set을 등록할 때까지
     * SCHEMA_HASH_MISMATCH다. 모든 connection은 datetime을 UTC로 읽고 쓴다
     * (docs/dialects.md): MySQL과 PostgreSQL session의 time zone은 UTC다.
     */
    public static function connect(string $dsn, Config $config): Db
    {
        [$driver, $pdoDsn, $user, $password, $pragmas, $sslCa] = self::parseDsn($dsn);
        if ($config->poolSize < 0) {
            throw new OrmException(Code::CONFIG, 'pool size must not be negative');
        }
        if ($config->statementTimeoutMs < 0) {
            throw new OrmException(Code::CONFIG, 'statement timeout must not be negative');
        }
        if ($config->poolIdleSize !== 0 || $config->poolLifetimeMs !== 0) {
            throw new OrmException(Code::CONFIG, 'poolIdleSize and poolLifetimeMs configure a connection pool, and the PHP client has none');
        }
        if ($driver === 'postgres' && $config->statementTimeoutMs > 0) {
            // A startup parameter belongs to the client session, so a pooler
            // in transaction mode sets it on every server connection it
            // assigns to this connection and on no other.
            $pdoDsn .= ";options='-c statement_timeout=" . $config->statementTimeoutMs . "'";
        }
        try {
            $options = $driver === 'mysql' ? [\Pdo\Mysql::ATTR_FOUND_ROWS => true] : [];
            $options += self::mysqlTlsOptions($sslCa);
            $pdo = new \PDO($pdoDsn, $user, $password, $options);
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            switch ($driver) {
                case 'mysql':
                    $pdo->exec("SET time_zone = '+00:00'");
                    if ($config->statementTimeoutMs > 0) {
                        // MySQL bounds SELECT statements with max_execution_time.
                        $pdo->exec('SET SESSION max_execution_time = ' . $config->statementTimeoutMs);
                    }
                    break;
                case 'postgres':
                    $pdo->exec("SET TIME ZONE 'UTC'");
                    break;
                default:
                    $version = (string) $pdo->query('SELECT sqlite_version()')->fetchColumn();
                    if (version_compare($version, '3.46', '<')) {
                        throw new OrmException(Code::CAPABILITY_UNSUPPORTED, "SQLite $version is older than 3.46");
                    }
                    $pdo->exec('PRAGMA foreign_keys = ON');
                    $pdo->exec('PRAGMA busy_timeout = ' . self::SQLITE_BUSY_TIMEOUT_MS);
                    foreach ($pragmas as [$name, $value]) {
                        $pdo->exec("PRAGMA $name = $value");
                    }
            }
        } catch (\PDOException $e) {
            throw new OrmException(Code::CONFIG, 'cannot connect: ' . $e->getMessage(), $e);
        }
        return new Db($pdo, $driver, $config, new \DateTimeZone('UTC'));
    }

    /**
     * `timezone` parameter는 UTC(`+00:00`, `UTC`)만 받는다. 다른 zone은 UTC 규칙과
     * 맞지 않으므로 CONFIG로 실패한다.
     *
     * @return array{0: string, 1: string, 2: ?string, 3: ?string, 4: list<array{0: string, 1: string}>, 5: ?string}
     *     driver, PDO DSN, user, password, the SQLite `_pragma=name(value)` parameters, and the
     *     MySQL `ssl-ca` path of ssl-mode=VERIFY_IDENTITY
     */
    public static function parseDsn(string $dsn): array
    {
        if (preg_match('#^([a-z][a-z0-9+.-]*)://#i', $dsn, $m) !== 1) {
            throw new OrmException(Code::CONFIG, 'dsn must be a URI using mysql://, postgres://, or sqlite://');
        }
        $driver = strtolower($m[1]);
        if (!in_array($driver, Db::DRIVERS, true)) {
            throw new OrmException(Code::CONFIG, "unsupported DSN scheme $driver; want mysql, postgres, or sqlite");
        }
        $parts = parse_url(str_replace($m[1] . ':///', $m[1] . '://localhost/', $dsn));
        if ($parts === false) {
            throw new OrmException(Code::CONFIG, 'invalid DSN URI');
        }
        $query = [];
        parse_str((string) ($parts['query'] ?? ''), $query);
        $accepted = self::DSN_PARAMETERS[$driver];
        foreach (explode('&', (string) ($parts['query'] ?? '')) as $pair) {
            $key = urldecode(explode('=', $pair, 2)[0]);
            if ($pair !== '' && !in_array($key, $accepted, true)) {
                throw new OrmException(Code::CONFIG, "$driver DSN has the unknown parameter $key; it accepts " . implode(', ', $accepted));
            }
        }
        if (isset($query['timezone']) && !in_array($query['timezone'], ['+00:00', 'UTC'], true)) {
            throw new OrmException(Code::CONFIG, 'dsn timezone ' . (is_string($query['timezone']) ? $query['timezone'] : '') . ': every connection reads and writes datetime values in UTC');
        }
        $user = isset($parts['user']) ? rawurldecode($parts['user']) : null;
        $password = isset($parts['pass']) ? rawurldecode($parts['pass']) : null;
        $path = (string) ($parts['path'] ?? '');
        $name = ltrim($path, '/');
        switch ($driver) {
            case 'mysql':
                if ($name === '' || (!isset($query['socket']) && ($parts['host'] ?? '') === '')) {
                    throw new OrmException(Code::CONFIG, 'mysql DSN must include host and database');
                }
                $pdo = isset($query['socket'])
                    ? 'mysql:unix_socket=' . $query['socket']
                    : 'mysql:host=' . $parts['host'] . (isset($parts['port']) ? ';port=' . $parts['port'] : '');
                return [$driver, $pdo . ';dbname=' . $name . ';charset=utf8mb4', $user ?? '', $password ?? '', [], self::mysqlTls($query, (string) ($parts['host'] ?? ''))];
            case 'postgres':
                if ($name === '') {
                    throw new OrmException(Code::CONFIG, 'postgres DSN must include host and database');
                }
                $host = $query['host'] ?? ($parts['host'] ?? '');
                if ($host === '') {
                    throw new OrmException(Code::CONFIG, 'postgres DSN must include host and database');
                }
                $pdo = 'pgsql:host=' . $host . ';port=' . ($parts['port'] ?? 5432) . ';dbname=' . $name;
                if (isset($query['sslmode'])) {
                    $pdo .= ';sslmode=' . $query['sslmode'];
                }
                return [$driver, $pdo, $user, $password, [], null];
            default:
                if (!str_starts_with($dsn, 'sqlite:///') || $path === '') {
                    throw new OrmException(Code::CONFIG, 'sqlite DSN must include an absolute database path');
                }
                $pragmas = [];
                foreach (explode('&', (string) ($parts['query'] ?? '')) as $pair) {
                    [$key, $value] = array_pad(explode('=', $pair, 2), 2, '');
                    $key = urldecode($key);
                    if ($key === '_txlock') {
                        throw new OrmException(Code::CONFIG, 'sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE');
                    }
                    if ($key !== '_pragma') {
                        continue;
                    }
                    $value = urldecode($value);
                    if (preg_match('/^([a-z_]+)\(([A-Za-z0-9_]+)\)$/', $value, $pragma) !== 1) {
                        throw new OrmException(Code::CONFIG, "sqlite DSN _pragma $value is invalid");
                    }
                    $pragmas[] = [$pragma[1], $pragma[2]];
                }
                // parse_url 은 path 를 decode 하지 않는다. 잘못된 escape, NUL, UTF-8 이 아닌
                // 결과는 다른 file 을 열게 되므로 거부한다.
                if (preg_match('/%(?![0-9A-Fa-f]{2})/', $path) === 1) {
                    throw new OrmException(Code::CONFIG, 'sqlite DSN path has a % without two hexadecimal digits');
                }
                $path = rawurldecode($path);
                if (str_contains($path, "\0")) {
                    throw new OrmException(Code::CONFIG, 'sqlite DSN path must not contain a NUL byte');
                }
                if (preg_match('//u', $path) !== 1) {
                    throw new OrmException(Code::CONFIG, 'sqlite DSN path must be UTF-8 after percent-decoding');
                }
                return [$driver, 'sqlite:' . $path, null, null, $pragmas, null];
        }
    }

    /**
     * MySQL TLS parameter를 검사한다: `ssl-ca`에 CA file의 절대 경로를 둔
     * `ssl-mode=VERIFY_IDENTITY`로 host 이름에 TCP 연결하거나, 둘 다 없다. CA 경로나 null을
     * 돌려준다.
     *
     * @param array<array-key, mixed> $query
     */
    private static function mysqlTls(array $query, string $host): ?string
    {
        $mode = isset($query['ssl-mode']) ? (string) $query['ssl-mode'] : null;
        $ca = isset($query['ssl-ca']) ? (string) $query['ssl-ca'] : null;
        if ($mode === null && $ca === null) {
            return null;
        }
        if ($mode !== 'VERIFY_IDENTITY') {
            throw new OrmException(Code::CONFIG, 'mysql DSN ssl-mode ' . json_encode($mode) . ' is not supported; the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca');
        }
        if ($ca === null || $ca === '') {
            throw new OrmException(Code::CONFIG, 'mysql DSN ssl-mode=VERIFY_IDENTITY needs ssl-ca, the absolute path of the CA file');
        }
        if ($ca[0] !== '/') {
            throw new OrmException(Code::CONFIG, "mysql DSN ssl-ca $ca is not an absolute path");
        }
        if (isset($query['socket'])) {
            throw new OrmException(Code::CONFIG, 'mysql DSN ssl-mode connects over TCP and does not accept socket');
        }
        // identity 검사는 host 이름을 인증서와 비교한다.
        if (filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) !== false) {
            throw new OrmException(Code::CONFIG, "mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address $host");
        }
        return $ca;
    }

    /**
     * ssl-mode=VERIFY_IDENTITY의 `ssl-ca` 경로로 만드는 PDO option이거나 빈 배열이다: server
     * 인증서를 CA와 host 이름으로 검사하는 TLS다. password는 TLS 안에서만 오가고, client는
     * server public key를 두지 않으므로 RSA password 교환을 하지 않는다.
     *
     * @return array<int, mixed>
     */
    public static function mysqlTlsOptions(?string $sslCa): array
    {
        if ($sslCa === null) {
            return [];
        }
        if (!is_file($sslCa) || !is_readable($sslCa)) {
            throw new OrmException(Code::CONFIG, "mysql DSN ssl-ca $sslCa is not a readable file");
        }
        return [\Pdo\Mysql::ATTR_SSL_CA => $sslCa, \Pdo\Mysql::ATTR_SSL_VERIFY_SERVER_CERT => true];
    }

    /** The retryable DEADLOCK error. */
    public static function transactionConflict(string $message): OrmException
    {
        return new OrmException(Code::DEADLOCK, $message);
    }

    public static function now(): Func
    {
        return new Func('now', [], false);
    }

    public static function today(): Func
    {
        return new Func('today', [], false);
    }

    public static function secondsAgo(int $n): Func
    {
        return new Func('seconds_ago', [$n], false);
    }

    public static function minutesAgo(int $n): Func
    {
        return new Func('minutes_ago', [$n], false);
    }

    public static function hoursAgo(int $n): Func
    {
        return new Func('hours_ago', [$n], false);
    }

    public static function daysAgo(int $n): Func
    {
        return new Func('days_ago', [$n], false);
    }

    public static function monthsAgo(int $n): Func
    {
        return new Func('months_ago', [$n], false);
    }

    public static function secondsLater(int $n): Func
    {
        return new Func('seconds_later', [$n], false);
    }

    public static function minutesLater(int $n): Func
    {
        return new Func('minutes_later', [$n], false);
    }

    public static function hoursLater(int $n): Func
    {
        return new Func('hours_later', [$n], false);
    }

    public static function daysLater(int $n): Func
    {
        return new Func('days_later', [$n], false);
    }

    public static function monthsLater(int $n): Func
    {
        return new Func('months_later', [$n], false);
    }

    public static function dayOfWeek(): Func
    {
        return new Func('day_of_week', [], true);
    }

    public static function year(): Func
    {
        return new Func('year', [], true);
    }

    public static function month(): Func
    {
        return new Func('month', [], true);
    }

    public static function date(): Func
    {
        return new Func('date', [], true);
    }
}

/** Connection options. */
final class Config
{
    /** key of aesVersion for aes writes; empty takes aesKeys[aesVersion] */
    public readonly string $aesKey;

    public function __construct(
        string $aesKey = '',
        public readonly string $blindIndexKey = '',
        public readonly int $aesVersion = 1,
        /** @var array<int, string> every declared AES key version */
        public readonly array $aesKeys = [],
        /** maximum connections a process opens for this database; zero uses the driver default */
        public readonly int $poolSize = 0,
        /** bound of every statement of the connection in milliseconds; zero keeps the server default */
        public readonly int $statementTimeoutMs = 0,
        /** maximum idle connections of a pool; the PHP client has no pool and accepts only zero */
        public readonly int $poolIdleSize = 0,
        /** lifetime of a pool connection in milliseconds; the PHP client has no pool and accepts only zero */
        public readonly int $poolLifetimeMs = 0,
        public readonly int $planCacheSize = 256,
        public readonly int $statementCacheSize = 256,
        /**
         * fn(): array<string, mixed> giving the audit record values of a transaction with audit
         * values, such as the account and the request; the transaction calls it once before it
         * begins, and its values of the same column lose to the values of the transaction
         */
        public readonly ?\Closure $auditSource = null,
    ) {
        if ($aesVersion < 1 || $planCacheSize < 1 || $statementCacheSize < 1) {
            throw new OrmException(Code::CONFIG, 'AES version and cache sizes must be positive');
        }
        if ($aesKey !== '' && $aesKeys !== [] && ($aesKeys[$aesVersion] ?? '') !== $aesKey) {
            throw new OrmException(Code::CONFIG, "aesKey differs from aesKeys[$aesVersion]");
        }
        $this->aesKey = $aesKey !== '' ? $aesKey : ($aesKeys[$aesVersion] ?? '');
    }

    public function keyring(): AesKeyring
    {
        if ($this->aesKeys !== []) {
            return new AesKeyring($this->aesKeys, $this->aesVersion);
        }
        if ($this->aesKey === '') {
            throw new OrmException(Code::CONFIG, 'secret aes is not configured');
        }
        return new AesKeyring([$this->aesVersion => $this->aesKey], $this->aesVersion);
    }
}

final class OrmException extends \RuntimeException
{
    /**
     * @param ?\Throwable $rollback the rollback error of a ROLLBACK error, whose
     *     previous exception is the callback error
     */
    public function __construct(public readonly string $code_, string $message, ?\Throwable $previous = null, public readonly ?\Throwable $rollback = null)
    {
        parent::__construct($code_ . ': ' . $message, 0, $previous);
    }

    /**
     * transaction이나 savepoint의 작업이 실패하고 그 rollback도 실패한 오류다.
     * 원인을 previous로, rollback 오류를 rollback으로 갖는다.
     */
    public static function rollback(\Throwable $cause, \Throwable $rollback): self
    {
        return new self(Code::ROLLBACK, 'transaction failed (' . $cause->getMessage() . ') and rollback failed (' . $rollback->getMessage() . ')', $cause, $rollback);
    }

    /**
     * Reports a driver error with the code the error catalog names for it,
     * and every other driver error with DRIVER. The exception keeps the driver
     * message and the driver error as its previous exception.
     */
    public static function fromDriver(\PDOException $e, string $driver): self
    {
        $state = (string) ($e->errorInfo[0] ?? $e->getCode());
        $num = $e->errorInfo[1] ?? null;
        $message = (string) ($e->errorInfo[2] ?? '');
        $code = match ($driver) {
            'postgres' => match ($state) {
                '55P03' => Code::LOCK_NOT_AVAILABLE,
                '40P01', '40001' => Code::DEADLOCK,
                '23505' => Code::DUPLICATE_KEY,
                '23503' => Code::FOREIGN_KEY,
                '57014' => Code::CANCELED,
                '25006' => Code::READ_ONLY,
                '23514' => Code::CONSTRAINT,
                default => Code::DRIVER,
            },
            'sqlite' => match (true) {
                // SQLITE_BUSY: another connection held the lock when busy_timeout ended.
                is_int($num) && ($num & 0xff) === 5 => Code::CANCELED,
                in_array($num, [6, 262], true) => Code::DEADLOCK,
                in_array($num, [2067, 1555], true) || ($num === 19 && str_starts_with($message, 'UNIQUE constraint failed')) => Code::DUPLICATE_KEY,
                // RESTRICT action의 FK 위반은 CONSTRAINT_TRIGGER(1811)로 온다. trigger RAISE의 1811은 DRIVER다.
                $num === 787 || (in_array($num, [19, 1811], true) && str_starts_with($message, 'FOREIGN KEY constraint failed')) => Code::FOREIGN_KEY,
                $num === 275 || ($num === 19 && str_starts_with($message, 'CHECK constraint failed')) => Code::CONSTRAINT,
                $num === 9 => Code::CANCELED,
                is_int($num) && ($num & 0xff) === 8 => Code::READ_ONLY,
                default => Code::DRIVER,
            },
            default => match (true) {
                $num === 3572 || $state === 'ER_LOCK_NOWAIT' => Code::LOCK_NOT_AVAILABLE,
                $num === 1213 || $state === '40001' => Code::DEADLOCK,
                $num === 1062 || ($num === null && $state === '23000') => Code::DUPLICATE_KEY,
                $num === 1451 || $num === 1452 => Code::FOREIGN_KEY,
                $num === 1317 || $num === 3024 => Code::CANCELED,
                $num === 1290 || $num === 1792 => Code::READ_ONLY,
                $num === 3819 || $num === 4025 => Code::CONSTRAINT,
                default => Code::DRIVER,
            },
        };
        return new self($code, $e->getMessage(), $e);
    }
}
