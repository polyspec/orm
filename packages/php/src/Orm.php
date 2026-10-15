<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** Opens connections and creates ORM function values. */
final class Orm
{
    /** milliseconds a SQLite connection waits for a lock when the DSN sets no _pragma=busy_timeout(ms) */
    private const SQLITE_BUSY_TIMEOUT_MS = 5000;
    /** MySQL 연결마다 정하는 session sql_mode다. 결과가 server 설정에 따르지 않는다(tests/dsn/mysql-session.json). */
    private const MYSQL_SQL_MODE = 'STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

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
     * (docs/dialects.md): MySQL과 PostgreSQL session의 time zone은 UTC다. 연결은
     * Db마다 하나이고 Db와 함께 끝난다. PHP client는 pool을 두지 않는다.
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
                // session 설정은 연결이 열릴 때 한 번 실행되는 init command 하나다. 설정마다
                // statement를 따로 보내는 round trip이 들지 않는다.
                $options = [
                    \Pdo\Mysql::ATTR_FOUND_ROWS => true,
                    // MySQL bounds SELECT statements with max_execution_time.
                    \Pdo\Mysql::ATTR_INIT_COMMAND => "SET time_zone = '+00:00', sql_mode = '" . self::MYSQL_SQL_MODE . "'" . ($config->statementTimeoutMs > 0 ? ', SESSION max_execution_time = ' . $config->statementTimeoutMs : ''),
                ] + self::mysqlTlsOptions($sslCa);
                break;
            case 'postgres':
                // startup parameter는 client session에 속하므로 transaction mode의 pooler는
                // 이 연결에 배정하는 모든 server connection에 그것을 두고 다른 연결에는 두지
                // 않는다. time zone도 startup parameter이므로 연결은 SET statement를 보내지 않는다.
                $pdoDsn .= ";options='-c TimeZone=UTC" . ($config->statementTimeoutMs > 0 ? ' -c statement_timeout=' . $config->statementTimeoutMs : '') . "'";
                break;
        }
        try {
            $pdo = \PDO::connect($pdoDsn, $user, $password, $options);
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            if ($driver === 'sqlite') {
                // pdo_sqlite가 link한 SQLite library의 version이다. 그것을 묻는 statement를 보내지 않는다.
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

    /** pool option과 statement timeout은 SQL 연결과 markdown 연결이 같은 규칙으로 검사한다. */
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
     * markdown://127.0.0.1:<port>/<corpus>?token=<token>이 가리키는 flowmark server에 연결한다
     * (docs/protocol.md §5). 연결 하나를 열고 connect message로 corpus와 token을 보낸다: server가
     * 거절한 corpus나 token은 그 CONFIG다. markdown executor는 statement timeout을 받지 않는다.
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

    /** DSN URI의 scheme이다. 소문자다. URI가 아니면 CONFIG다. */
    private static function scheme(string $dsn): string
    {
        if (preg_match('#^([a-z][a-z0-9+.-]*)://#i', $dsn, $m) !== 1) {
            throw new OrmException(Code::CONFIG, 'dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://');
        }
        return strtolower($m[1]);
    }

    /**
     * markdown://127.0.0.1:<port>/<corpus>?token=<token>을 읽는다. flowmark server는 127.0.0.1에서만
     * 듣고 token은 평문으로 가므로 host는 127.0.0.1뿐이다. 다른 host, 없는 port, 이름 하나가 아닌
     * path, 없는 token과 다른 parameter는 CONFIG다.
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
     * `timezone` parameter는 UTC(`+00:00`, `UTC`)만 받는다. 다른 zone은 UTC 규칙과
     * 맞지 않으므로 CONFIG로 실패한다.
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
