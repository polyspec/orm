<?php
declare(strict_types=1);
// case database: test case 하나가 쓰는 자기 database다. 공유 test database
// (ORM_TEST_MYSQL_DSN, ORM_TEST_POSTGRES_DSN의 database)가 비어 있다고 가정하지 않도록, schema를
// 설치하거나 빈 database를 확인하는 case는 이름이 겹치지 않는 database(MySQL, PostgreSQL)나
// SQLite file을 만들고 case가 끝날 때(실패한 뒤에도) 지운다. ORM_TEST_*_DSN은 database를
// 만들고 지우는 admin connection으로만 쓰고 그 database에는 아무것도 만들지 않는다.
// PostgreSQL도 schema가 아닌 database를 받는다: empty()는 public이 아닌 schema를 내용으로 센다.
// 호출하는 script가 Polyspec\Orm\Orm을 autoload한다.

use Polyspec\Orm\Orm;

/** process에서 겹치지 않는 이름 orm_case_<pid>_<counter>다. counter는 1부터 센다. */
function case_name(): string
{
    static $counter = 0;
    $counter++;
    return 'orm_case_' . getmypid() . '_' . $counter;
}

/** DSN의 path(database 이름)를 $name으로 바꾼다. query는 그대로 둔다. */
function case_dsn_with_database(string $dsn, string $name): string
{
    $replaced = preg_replace('~^([a-z]+://[^/?#]*)(/[^?#]*)?~', '${1}/' . $name, $dsn, 1, $count);
    if ($replaced === null || $count !== 1) {
        throw new InvalidArgumentException('a DSN without a scheme and authority');
    }
    return $replaced;
}

final class CaseDatabase
{
    private bool $dropped = false;

    /** @param callable(string): void $step */
    public function __construct(
        public readonly string $driver,
        public readonly string $name,
        public readonly string $dsn,
        private readonly ?string $admin,
        private $step,
    ) {
    }

    /** 다른 server(replica)의 DSN을 이 database 이름으로 바꾼다. */
    public function related(string $dsn): string
    {
        return case_dsn_with_database($dsn, $this->name);
    }

    /** database나 SQLite file을 지운다. 두 번째 호출은 아무것도 하지 않는다. */
    public function drop(): void
    {
        if ($this->dropped) {
            return;
        }
        $this->dropped = true;
        if ($this->driver === 'sqlite') {
            foreach (['', '-wal', '-shm', '-journal'] as $suffix) {
                $file = $this->name . $suffix;
                if (file_exists($file) && !unlink($file)) {
                    throw new RuntimeException("drop sqlite file $file: unlink failed");
                }
            }
            ($this->step)("database file {$this->name} removed");
            return;
        }
        try {
            $pdo = case_admin($this->admin);
            $pdo->exec("DROP DATABASE {$this->name}" . ($this->driver === 'postgres' ? ' WITH (FORCE)' : ''));
        } catch (Throwable $e) {
            throw new RuntimeException("drop database {$this->name}: {$e->getMessage()}", 0, $e);
        }
        ($this->step)("database {$this->name} dropped");
    }
}

/** admin DSN의 PDO connection이다. */
function case_admin(string $dsn): PDO
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    return new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

/**
 * $driver의 새 case database를 만들고 STEP 줄로 알린다. MySQL과 PostgreSQL은 ORM_TEST_<DRIVER>_DSN의
 * server에 database를, SQLite는 temp directory에 file을 만든다. 호출자가 drop()을 부른다.
 *
 * @param callable(string): void $step 실행 중인 case의 단계 줄 출력(testcase_run의 $step이나 testcase_step)
 */
function case_database(string $driver, callable $step): CaseDatabase
{
    $name = case_name();
    if ($driver === 'sqlite') {
        $path = sys_get_temp_dir() . '/' . str_replace('_', '-', $name) . '.sqlite';
        if (file_exists($path) || !touch($path)) {
            throw new RuntimeException("create sqlite file $path: the file exists or cannot be created");
        }
        $step("database file $path created");
        return new CaseDatabase($driver, $path, "sqlite://$path", null, $step);
    }
    if (!in_array($driver, ['mysql', 'postgres'], true)) {
        throw new InvalidArgumentException("case database of driver $driver");
    }
    $env = 'ORM_TEST_' . strtoupper($driver) . '_DSN';
    $admin = getenv($env);
    if ($admin === false || $admin === '') {
        throw new RuntimeException("$env is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers");
    }
    try {
        case_admin($admin)->exec("CREATE DATABASE $name");
    } catch (Throwable $e) {
        throw new RuntimeException("create database $name: {$e->getMessage()}", 0, $e);
    }
    $step("database $name created");
    return new CaseDatabase($driver, $name, case_dsn_with_database($admin, $name), $admin, $step);
}

/**
 * 새 case database의 DSN으로 $body를 실행하고, 성공해도 실패해도 database를 지운다. 지우기가
 * 실패하면 그 database 이름과 함께 실패하고, $body도 실패했으면 두 이유를 함께 담는다.
 *
 * @param callable(string): void $step
 * @param callable(string, CaseDatabase): mixed $body
 */
function with_case_database(string $driver, callable $step, callable $body): mixed
{
    $database = case_database($driver, $step);
    try {
        $result = $body($database->dsn, $database);
    } catch (Throwable $e) {
        try {
            $database->drop();
        } catch (Throwable $dropped) {
            throw new RuntimeException("{$e->getMessage()}; {$dropped->getMessage()}", 0, $e);
        }
        throw $e;
    }
    $database->drop();
    return $result;
}
