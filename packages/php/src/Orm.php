<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** Opens connections and creates ORM function values. */
final class Orm
{
    /** milliseconds a SQLite connection waits for a lock when the DSN sets no _pragma=busy_timeout(ms) */
    private const SQLITE_BUSY_TIMEOUT_MS = 5000;
    /** The session sql_mode decided per MySQL connection. The result does not depend on server settings (tests/dsn/mysql-session.json). */
    private const MYSQL_SQL_MODE = 'STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

    /** The parameters that each scheme's DSN accepts (docs/config.md). Other parameters are CONFIG. */
    private const DSN_PARAMETERS = [
        'mysql' => ['timezone', 'socket', 'ssl-mode', 'ssl-ca'],
        'postgres' => ['timezone', 'host', 'sslmode'],
        'sqlite' => ['timezone', '_pragma', '_txlock'],
    ];

    /**
     * Opens the database that the DSN URI (mysql://, postgres://, sqlite://) selects, and
     * registers the generated schema's set on that connection, as utils()->schema()->register does. Called by the generated code's
     * connect helper. If the text does not hash to the declared hash, it is CONFIG before the connection is opened.
     * Registration does not read the database; install and addTablesAndColumns
     * check it.
     */
    public static function connectSchema(string $dsn, Schema $schema, Config $config): Db
    {
        $schema->verify();
        $db = self::connect($dsn, $config);
        $db->registerSet($schema);
        return $db;
    }

    /**
     * Opens the database that the DSN URI (mysql://, postgres://, sqlite://) selects. The connection
     * has no registered set, so a model request gives SCHEMA_HASH_MISMATCH until install registers that set.
     * All connections read and write datetime as UTC
     * (docs/dialects.md): the time zone of MySQL and PostgreSQL sessions is UTC. A connection
     * is one per Db and ends with the Db. The PHP client has no pool.
     */
    public static function connect(string $dsn, Config $config): Db
    {
        if (self::scheme($dsn) === 'markdown') {
            return self::connectMarkdown($dsn, $config);
        }
        [$driver, $pdoDsn, $user, $password, $pragmas, $sslCa] = self::parseDsn($dsn);
        self::checkConnectionConfig($config);
        $options = [];
        switch ($driver) {
            case 'mysql':
                // Session settings are one init command that runs once when the connection opens. Each setting
                // does not incur a separate round trip to send a statement.
                $options = [
                    \Pdo\Mysql::ATTR_FOUND_ROWS => true,
                    // MySQL bounds SELECT statements with max_execution_time.
                    \Pdo\Mysql::ATTR_INIT_COMMAND => "SET time_zone = '+00:00', sql_mode = '" . self::MYSQL_SQL_MODE . "'" . ($config->statementTimeoutMs > 0 ? ', SESSION max_execution_time = ' . $config->statementTimeoutMs : ''),
                ] + self::mysqlTlsOptions($sslCa);
                break;
            case 'postgres':
                // Startup parameters belong to the client session, so a pooler in transaction mode
                // puts them on every server connection assigned to this connection, and does not put them on other connections.
                // Since the time zone is also a startup parameter, the connection does not send a SET statement.
                $pdoDsn .= ";options='-c TimeZone=UTC" . ($config->statementTimeoutMs > 0 ? ' -c statement_timeout=' . $config->statementTimeoutMs : '') . "'";
                break;
        }
        try {
            $pdo = \PDO::connect($pdoDsn, $user, $password, $options);
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            if ($driver === 'sqlite') {
                // The version of the SQLite library that pdo_sqlite linked. It does not send a statement that asks for it.
                $version = (string) $pdo->getAttribute(\PDO::ATTR_SERVER_VERSION);
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

    /** Pool options and statement timeout are checked by the same rules for SQL and markdown connections. */
    private static function checkConnectionConfig(Config $config): void
    {
        if ($config->poolSize !== 0 || $config->poolIdleSize !== 0 || $config->poolLifetimeMs !== 0) {
            throw new OrmException(Code::CONFIG, 'poolSize, poolIdleSize and poolLifetimeMs configure a connection pool, and the PHP client opens one connection per Db and keeps no pool; pool PHP connections with PgBouncer or ProxySQL (docs/config.md "Connection poolers")');
        }
        if ($config->statementTimeoutMs < 0) {
            throw new OrmException(Code::CONFIG, 'statement timeout must not be negative');
        }
    }

    /**
     * Connects to the flowmark server that markdown://127.0.0.1:<port>/<corpus>?token=<token> points at
     * (docs/protocol.md §5). Opens one connection and sends the corpus and token in a connect message: if the server
     * rejects the corpus or token, it is CONFIG. The markdown executor does not accept a statement timeout.
     */
    private static function connectMarkdown(string $dsn, Config $config): Db
    {
        [$address, $corpus, $token] = self::parseMarkdownDsn($dsn);
        self::checkConnectionConfig($config);
        if ($config->statementTimeoutMs > 0) {
            throw Markdown::unsupported('statement timeout');
        }
        return new Db(null, 'markdown', $config, new \DateTimeZone('UTC'), MarkdownSession::dial($address, $corpus, $token));
    }

    /** The scheme of the DSN URI, in lowercase. If it is not a URI, it is CONFIG. */
    private static function scheme(string $dsn): string
    {
        if (preg_match('#^([a-z][a-z0-9+.-]*)://#i', $dsn, $m) !== 1) {
            throw new OrmException(Code::CONFIG, 'dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://');
        }
        return strtolower($m[1]);
    }

    /**
     * Reads markdown://127.0.0.1:<port>/<corpus>?token=<token>. The flowmark server listens only on 127.0.0.1,
     * and the token travels in plain text, so the host is only 127.0.0.1. Another host, a missing port, a path that is not one name,
     * a missing token, and any other parameter are CONFIG.
     *
     * @return array{0: string, 1: string, 2: string} the server address, the corpus name and the token
     */
    public static function parseMarkdownDsn(string $dsn): array
    {
        $form = 'markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>';
        $parts = parse_url($dsn);
        if ($parts === false || strtolower($parts['scheme'] ?? '') !== 'markdown') {
            throw new OrmException(Code::CONFIG, "$form; give the port that flowmark serve printed and the corpus name");
        }
        if (isset($parts['user']) || isset($parts['pass'])) {
            throw new OrmException(Code::CONFIG, "$form; it takes no user");
        }
        $host = (string) ($parts['host'] ?? '');
        if ($host !== '127.0.0.1') {
            throw new OrmException(Code::CONFIG, "$form; host \"$host\": a flowmark server listens on 127.0.0.1 only");
        }
        $port = $parts['port'] ?? 0;
        if ($port < 1 || $port > 65535) {
            throw new OrmException(Code::CONFIG, "$form; port \"$port\" is not 1 to 65535: give the port that flowmark serve printed");
        }
        $path = (string) ($parts['path'] ?? '');
        $corpus = rawurldecode(substr($path, 1));
        if (!str_starts_with($path, '/') || $corpus === '' || str_contains($corpus, '/')) {
            throw new OrmException(Code::CONFIG, "$form; the path \"$path\" is not one corpus name: give the corpus root's directory name");
        }
        $tokens = [];
        foreach (explode('&', (string) ($parts['query'] ?? '')) as $pair) {
            if ($pair === '') {
                continue;
            }
            [$key, $value] = array_pad(explode('=', $pair, 2), 2, '');
            $key = urldecode($key);
            if ($key !== 'token') {
                throw new OrmException(Code::CONFIG, "$form; it does not accept $key");
            }
            $tokens[] = urldecode($value);
        }
        if (count($tokens) !== 1 || $tokens[0] === '') {
            throw new OrmException(Code::CONFIG, "$form; give one token, the token of .flowmark/server.json of the corpus");
        }
        return ["127.0.0.1:$port", $corpus, $tokens[0]];
    }

    /**
     * The `timezone` parameter accepts only UTC (`+00:00`, `UTC`). Another zone does not fit the UTC rule,
     * so it fails as CONFIG.
     *
     * @return array{0: string, 1: string, 2: ?string, 3: ?string, 4: list<array{0: string, 1: string}>, 5: ?string}
     *     driver, PDO DSN, user, password, the SQLite `_pragma=name(value)` parameters, and the
     *     MySQL `ssl-ca` path of ssl-mode=VERIFY_IDENTITY
     */
    public static function parseDsn(string $dsn): array
    {
        $driver = self::scheme($dsn);
        if ($driver === 'markdown') {
            throw new OrmException(Code::CONFIG, 'a markdown DSN selects the markdown IR executor and has no PDO DSN; read it with parseMarkdownDsn');
        }
        if (!in_array($driver, Db::DRIVERS, true)) {
            throw new OrmException(Code::CONFIG, "unsupported DSN scheme $driver; want mysql, postgres, sqlite, or markdown");
        }
        $scheme = substr($dsn, 0, strlen($driver));
        $parts = parse_url(str_replace($scheme . ':///', $scheme . '://localhost/', $dsn));
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
                // parse_url does not decode the path. An invalid escape, a NUL, or non-UTF-8
                // would open a different file, so they are rejected.
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
     * Checks the MySQL TLS parameters: `ssl-ca` with the absolute path of a CA file, and
     * `ssl-mode=VERIFY_IDENTITY` connecting over TCP to a host name, or neither. Returns the CA path or null
     * (returns null when neither is present).
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
        // The identity check compares the host name with the certificate.
        if (filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) !== false) {
            throw new OrmException(Code::CONFIG, "mysql DSN ssl-mode=VERIFY_IDENTITY needs a host name, not the address $host");
        }
        return $ca;
    }

    /**
     * Either the PDO option made from the ssl-ca path of ssl-mode=VERIFY_IDENTITY, or an empty array: the server
     * certificate is checked against the CA and the host name, over TLS. The password travels only inside TLS, and the client
     * holds no server public key, so it does not do an RSA password exchange.
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
