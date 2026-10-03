<?php
// Several dbspec document sets in one process, on SQLite, MySQL and
// PostgreSQL. The generated bench models (clients/php/gen) and the models of
// contracts/fixtures/decimal_schema.dbs, generated into their own namespace,
// are loaded together; each model class carries the manifestHash of its own
// set. A connection plans only the sets registered on it: the connect helper
// of generated code and install register a set, and a raw connection
// registers none. A request of a set that is not registered on its connection
// fails with SCHEMA_HASH_MISMATCH before execution, also when another
// connection installed the set. A manifest text that does not hash to its
// declared manifestHash fails with CONFIG when it is connected or installed,
// and generated code of such a text fails with SCHEMA_HASH_MISMATCH when it
// loads. Each case runs in its own database (a new SQLite file, or a database
// the case creates on the server of ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN); the test fails when either variable is unset.
// Usage: php clients/php/tests/schema_set_test.php [case ...]
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Tests\Model\User;
use Orm\Code;
use Orm\Config;
use Orm\Generator;
use Orm\Orm;
use Orm\OrmException;
use Orm\RuntimeModel;
use Orm\Schema;
use SchemaSetDecimal\Orm\DecimalCase;

const CASE_DEADLINE_SECONDS = 60;

$root = dirname(__DIR__, 3);
$work = sys_get_temp_dir() . '/orm-php-schema-set-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

/** $namespace의 class를 $dir의 generated 파일에서 읽는 autoloader를 등록한다. */
function autoload(string $dir, string $namespace): void
{
    spl_autoload_register(static function (string $class) use ($dir, $namespace): void {
        if (str_starts_with($class, "$namespace\\")) {
            require "$dir/" . substr($class, strlen($namespace) + 1) . '.php';
        }
    });
}

$decimalDocuments = [(string) file_get_contents("$root/contracts/fixtures/decimal_schema.dbs")];
$decimalModel = RuntimeModel::build(RuntimeModel::parse(['decimal_schema.dbs' => $decimalDocuments[0]]));
Generator::generate($decimalModel, "$work/decimal", 'SchemaSetDecimal\\Orm');
autoload("$work/decimal", 'SchemaSetDecimal\\Orm');
require "$work/decimal/bootstrap.php";

$failures = 0;
$current = '';
function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

/** call이 던진 OrmException의 code다. 오류가 없으면 빈 문자열이다. */
function code(callable $f): string
{
    try {
        $f();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return '';
}

/**
 * case 하나의 database다: SQLite는 새 file, MySQL과 PostgreSQL은 base DSN의
 * server에 새로 만든 database다. 돌려주는 함수가 그 database를 지운다.
 * @return array{0: string, 1: Closure(): void}
 */
function caseDatabase(string $driver, string $base): array
{
    global $work;
    static $n = 0;
    $name = sprintf('orm_schema_set_%d_%d', getmypid(), ++$n);
    if ($driver === 'sqlite') {
        $path = "$work/$name.sqlite";
        return ["sqlite://$path", static function () use ($path): void {
            foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
                if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
                    throw new RuntimeException("$path$suffix cannot be removed");
                }
            }
        }];
    }
    [, $pdoDsn, $user, $password] = Orm::parseDsn($base);
    $admin = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $dsn = preg_replace('#^([a-z]+://[^/?]*)/[^?]*#', '$1/' . $name, $base, 1, $replaced);
    if ($replaced !== 1) {
        throw new RuntimeException('the test DSN names no database');
    }
    $admin->exec("CREATE DATABASE $name");
    return [$dsn, static function () use ($admin, $driver, $name): void {
        $admin->exec("DROP DATABASE $name" . ($driver === 'postgres' ? ' WITH (FORCE)' : ''));
    }];
}

/**
 * bench helper로 연 연결이 bench와 decimal set을 설치하고(decimal은 두 번이며
 * 두 번째 설치는 아무것도 바꾸지 않는다) 두 set의 model을 transaction 안팎에서 쓴다.
 */
function severalSchemas(string $dsn): void
{
    $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
    try {
        foreach ([\Polyspec\Orm\Tests\Model\schema(), \SchemaSetDecimal\Orm\schema(), \SchemaSetDecimal\Orm\schema()] as $schema) {
            $db->utils()->schema()->install($schema);
        }
        (new User)($db)->setName('core')->create();
        (new DecimalCase)($db)->setSeq(1)->setAmount('48.0450')->create();
        $db->transaction(function (): void {
            (new User)->setName('core-tx')->create();
            (new DecimalCase)->setSeq(2)->setAmount('1.5000')->create();
        }, retry: 0);
        $users = (new User)($db)->getCount();
        check($users === 2, "core rows $users");
        $amount = (new DecimalCase)($db)->addAllColumns()->getBySeq(1)->getAmount();
        check($amount === '48.0450', "decimal amount $amount");
        $decimals = (new DecimalCase)($db)->getCount();
        check($decimals === 2, "decimal rows $decimals");
    } finally {
        $db->close();
    }
}

/** 실행한 statement 수를 세는 Config다. */
function counted(int &$n): Config
{
    return new Config(onQuery: static function () use (&$n): void {
        $n++;
    });
}

/**
 * 연결에 등록되지 않은 set의 요청은 table이 있어도 실행 전에
 * SCHEMA_HASH_MISMATCH다. raw 연결은 아무 set도 등록하지 않고, bench helper로
 * 연 연결은 다른 연결이 설치한 decimal set을 등록하지 않는다. decimal helper로
 * 연 연결은 그 set을 쓴다.
 */
function unregisteredSchema(string $dsn): void
{
    $runs = 0;
    $raw = Orm::connect($dsn, counted($runs));
    try {
        check(code(fn() => (new User)($raw)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'bench read on a raw connection');
    } finally {
        $raw->close();
    }
    $core = \Polyspec\Orm\Tests\Model\connect($dsn, counted($runs));
    try {
        $installer = \SchemaSetDecimal\Orm\connect($dsn, new Config());
        try {
            $installer->utils()->schema()->install(\SchemaSetDecimal\Orm\schema());
            (new DecimalCase)($installer)->setSeq(1)->setAmount('1.0000')->create();
        } finally {
            $installer->close();
        }
        check(code(fn() => (new DecimalCase)($core)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'decimal read on the bench connection');
        check(code(fn() => (new DecimalCase)($core)->setSeq(2)->setAmount('2.0000')->create()) === Code::SCHEMA_HASH_MISMATCH, 'decimal write on the bench connection');
        check($runs === 0, "unregistered requests ran $runs statements");
    } finally {
        $core->close();
    }
    $decimal = \SchemaSetDecimal\Orm\connect($dsn, new Config());
    try {
        $rows = (new DecimalCase)($decimal)->getCount();
        check($rows === 1, "decimal rows through the decimal helper $rows");
    } finally {
        $decimal->close();
    }
}

/**
 * manifest text가 선언한 manifestHash로 hash되지 않는 schema의 connect와
 * install은 어떤 statement보다 먼저 CONFIG이고 table을 바꾸지 않는다. 그런
 * text의 generated code는 load할 때 SCHEMA_HASH_MISMATCH다.
 */
function editedManifest(string $dsn): void
{
    global $work, $decimalDocuments, $decimalModel;
    static $edits = 0;
    $edited = new Schema(str_replace('decimal(13,4)', 'decimal(14,4)', $decimalModel->manifestText), $decimalModel->manifestHash);
    check($edited->manifestText !== $decimalModel->manifestText, 'edited manifest differs');
    check(code(fn() => Orm::connectSchema($dsn, $edited, new Config())) === Code::CONFIG, 'connect with an edited manifest');
    $runs = 0;
    $db = \SchemaSetDecimal\Orm\connect($dsn, counted($runs));
    try {
        check(code(fn() => $db->utils()->schema()->install($edited)) === Code::CONFIG, 'install of an edited manifest');
        check($runs === 0, "the edited install ran $runs statements");
        $db->utils()->schema()->install(\SchemaSetDecimal\Orm\schema());
        check((new DecimalCase)($db)->getCount() === 0, 'decimal read');
        // 편집한 text의 generated code가 진짜 decimal set의 hash를 선언한다.
        $editedModel = RuntimeModel::build(RuntimeModel::parse(['decimal_schema.dbs' => str_replace('decimal(13,4)', 'decimal(14,4)', $decimalDocuments[0])]));
        $namespace = 'SchemaSetEdited' . (++$edits) . '\\Orm';
        $dir = "$work/edited-$edits";
        Generator::generate($editedModel, $dir, $namespace);
        foreach (glob("$dir/*.php") as $file) {
            file_put_contents($file, str_replace($editedModel->manifestHash, $decimalModel->manifestHash, (string) file_get_contents($file)));
        }
        check(code(function () use ($dir): void {
            require "$dir/bootstrap.php";
        }) === Code::SCHEMA_HASH_MISMATCH, 'loading generated code of an edited manifest');
        [$driver] = Orm::parseDsn($dsn);
        $type = match ($driver) {
            'mysql' => $db->pdo()->query("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'decimal_case' AND COLUMN_NAME = 'amount'")->fetchColumn(),
            'postgres' => $db->pdo()->query("SELECT numeric_precision || ',' || numeric_scale FROM information_schema.columns WHERE table_name = 'decimal_case' AND column_name = 'amount'")->fetchColumn(),
            default => $db->pdo()->query("SELECT sql FROM sqlite_master WHERE name = 'decimal_case'")->fetchColumn(),
        };
        $unchanged = match ($driver) {
            'mysql' => $type === 'decimal(13,4)',
            'postgres' => $type === '13,4',
            default => is_string($type) && str_contains($type, '"amount"') && !str_contains($type, '14'),
        };
        check($unchanged, 'decimal_case.amount is unchanged: ' . var_export($type, true));
    } finally {
        $db->close();
    }
}

$cases = [
    'several_schemas' => severalSchemas(...),
    'unregistered_schema' => unregisteredSchema(...),
    'edited_manifest' => editedManifest(...),
];
$selected = array_slice($argv, 1) ?: array_keys($cases);
$targets = ['sqlite' => ''];
foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $env) {
    $v = getenv($env);
    if ($v === false || $v === '') {
        throw new RuntimeException("$env is required; database tests never skip");
    }
    $targets[$driver] = $v;
}
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    $caseBefore = $failures;
    foreach ($targets as $driver => $base) {
        $before = $failures;
        $current = "$case/$driver";
        $start = microtime(true);
        echo "RUN  $current\n";
        pcntl_async_signals(true);
        pcntl_signal(SIGALRM, static function (): never {
            throw new RuntimeException('timeout after ' . CASE_DEADLINE_SECONDS . ' s');
        });
        pcntl_alarm(CASE_DEADLINE_SECONDS);
        $drop = null;
        try {
            [$dsn, $drop] = caseDatabase($driver, $base);
            $cases[$case]($dsn);
        } catch (Throwable $e) {
            $failures++;
            fwrite(STDERR, "FAIL $current: $e\n");
        } finally {
            pcntl_alarm(0);
            try {
                if ($drop !== null) {
                    $drop();
                }
            } catch (Throwable $e) {
                $failures++;
                fwrite(STDERR, "FAIL $current: drop database: $e\n");
            }
        }
        printf("%s %s %.3fs\n", $failures === $before ? 'ok  ' : 'FAIL', $current, microtime(true) - $start);
    }
    if ($failures === $caseBefore) {
        echo "CASE $case PASS\n";
    }
}
if ($failures > 0) {
    fwrite(STDERR, "php schema set test: $failures failures\n");
    exit(1);
}
echo 'php schema set test: ' . count($selected) . ' cases on ' . count($targets) . " databases passed\n";
