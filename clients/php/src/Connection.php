<?php
declare(strict_types=1);

namespace Orm;

/**
 * @internal Db 하나의 물리 연결을 연다(docs/config.md "poolSize").
 *
 * Config의 poolSize가 0이면 pool이 없다: 연결은 Db가 살아 있는 동안만 산다. poolSize가 n이면 process는
 * 연결 설정(PDO DSN, 사용자, 비밀번호, driver option)마다 n개의 slot을 가진 pool을 두고, Db는 살아 있는
 * 동안 비어 있는 가장 앞 slot 하나를 가진다. 앞의 poolIdleSize개(0이면 n개) slot의 연결은 PDO
 * persistent 연결이므로 Db가 끝나도 process(php-fpm worker)에 남고, 같은 slot을 잡는 다음 Db(다음
 * 요청)가 그 연결을 다시 쓴다. 뒤의 slot은 persistent가 아니므로 Db가 끝나면 닫힌다. 모든 slot을 Db가
 * 가지고 있으면 기다릴 수 없으므로(PHP 요청은 thread 하나다) CONFIG다.
 *
 * 연결의 session 설정은 연결이 열릴 때만 정한다: PostgreSQL은 DSN의 startup parameter, MySQL은 연결 직후
 * 한 번 실행되는 init command다. 다시 쓰는 연결은 그 설정을 그대로 가진다.
 */
final class Connection
{
    /** milliseconds a SQLite connection waits for a lock when the DSN sets no _pragma=busy_timeout(ms) */
    private const SQLITE_BUSY_TIMEOUT_MS = 5000;

    /** @var array<string, array<int, true>> pool마다 살아 있는 Db가 가진 slot이다. */
    private static array $held = [];

    private bool $released = false;
    /** fromPdo가 받은 handle이다. open이 한 번 돌려준다. */
    private ?\PDO $given = null;

    /**
     * @param array<int, mixed> $options PDO driver option
     * @param list<array{0: string, 1: string}> $pragmas SQLite DSN의 `_pragma=name(value)`
     * @param string $pool pool의 key다. pool이 없으면 빈 문자열이다.
     */
    private function __construct(
        public readonly string $driver,
        private readonly string $pdoDsn,
        private readonly ?string $user,
        private readonly ?string $password,
        private readonly array $options,
        private readonly array $pragmas,
        private readonly string $pool,
        private readonly int $slot,
        private readonly bool $persistent,
    ) {}

    /**
     * Config의 pool에서 slot 하나를 잡는다. pool이 없으면 slot 없이 연결 하나를 연다.
     *
     * @param array<int, mixed> $options
     * @param list<array{0: string, 1: string}> $pragmas
     */
    public static function take(string $driver, string $pdoDsn, ?string $user, ?string $password, array $options, array $pragmas, Config $config): self
    {
        if ($config->poolSize === 0) {
            return new self($driver, $pdoDsn, $user, $password, $options, $pragmas, '', 0, false);
        }
        $pool = hash('sha256', serialize([$pdoDsn, $user, $password, $options, $pragmas]));
        $held = self::$held[$pool] ?? [];
        $slot = 0;
        while (isset($held[$slot])) {
            $slot++;
        }
        if ($slot >= $config->poolSize) {
            throw new OrmException(Code::CONFIG, "every connection of the pool of {$config->poolSize} belongs to an open Db of this process; close one or raise poolSize");
        }
        self::$held[$pool][$slot] = true;
        $persistent = $config->poolIdleSize === 0 || $slot < $config->poolIdleSize;
        return new self($driver, $pdoDsn, $user, $password, $options, $pragmas, $pool, $slot, $persistent);
    }

    /**
     * 이미 연 PDO handle 하나의 연결이다. pool과 slot이 없고, 그 handle을 잃으면 다시 열 수 없다.
     * driver 오류를 일으키는 test PDO로 Db를 만드는 client test가 쓴다.
     */
    public static function fromPdo(\PDO $pdo, string $driver): self
    {
        $connection = new self($driver, '', null, null, [], [], '', 0, false);
        $connection->given = $pdo;
        return $connection;
    }

    /**
     * 연결을 연다. persistent slot이면 process에 남은 그 slot의 연결을 다시 쓰고, 없거나 server가 끝낸
     * 연결이면 PDO가 새로 연다.
     */
    public function open(): \PDO
    {
        if ($this->pdoDsn === '') {
            if ($this->given === null) {
                throw new OrmException(Code::CONNECTION_LOST, 'the connection of a given PDO handle cannot be opened again');
            }
            $pdo = $this->given;
            $this->given = null;
            self::configure($pdo, $this->driver);
            return $pdo;
        }
        $options = $this->options;
        if ($this->persistent) {
            // PDO는 DSN, 사용자, 비밀번호와 이 문자열로 persistent 연결을 찾는다. driver option은 그
            // 찾기에 들지 않으므로 option이 다른 pool이 같은 연결을 쓰지 않도록 pool key를 넣는다.
            $options[\PDO::ATTR_PERSISTENT] = "orm:{$this->pool}:{$this->slot}";
        }
        try {
            $pdo = \PDO::connect($this->pdoDsn, $this->user, $this->password, $options);
            self::configure($pdo, $this->driver);
            if ($this->driver === 'sqlite') {
                // pdo_sqlite가 link한 SQLite library의 version이다. 그것을 묻는 statement를 보내지 않는다.
                $version = (string) $pdo->getAttribute(\PDO::ATTR_SERVER_VERSION);
                if (version_compare($version, '3.46', '<')) {
                    throw new OrmException(Code::CAPABILITY_UNSUPPORTED, "SQLite $version is older than 3.46");
                }
                // SQLite 연결은 process 안의 file handle이므로 pragma는 연결을 얻을 때마다 실행한다.
                $pdo->exec('PRAGMA foreign_keys = ON');
                $pdo->exec('PRAGMA busy_timeout = ' . self::SQLITE_BUSY_TIMEOUT_MS);
                foreach ($this->pragmas as [$name, $value]) {
                    $pdo->exec("PRAGMA $name = $value");
                }
            }
        } catch (\PDOException $e) {
            throw new OrmException(Code::CONFIG, 'cannot connect: ' . $e->getMessage(), $e);
        }
        return $pdo;
    }

    /** client가 모든 연결에 두는 PDO attribute다. */
    private static function configure(\PDO $pdo, string $driver): void
    {
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        // MySQL uses emulated prepares: a request runs most statement shapes once.
        $pdo->setAttribute(\PDO::ATTR_EMULATE_PREPARES, $driver === 'mysql');
        if ($driver === 'postgres') {
            // PostgreSQL은 statement와 bind를 unnamed statement 하나로 한 round trip에 전송한다.
            // named statement를 따로 prepare하는 round trip과 그 implicit transaction이 들지 않는다.
            // bind는 prepare할 때와 같은 server-side parameter이고 type 추론도 같다.
            $pdo->setAttribute(\Pdo\Pgsql::ATTR_DISABLE_PREPARES, true);
        }
        $pdo->setAttribute(\PDO::ATTR_STRINGIFY_FETCHES, false);
    }

    /** slot을 pool에 돌려준다. 두 번째 호출은 아무것도 하지 않는다. */
    public function release(): void
    {
        if ($this->released) {
            return;
        }
        $this->released = true;
        if ($this->pool !== '') {
            unset(self::$held[$this->pool][$this->slot]);
        }
    }
}
