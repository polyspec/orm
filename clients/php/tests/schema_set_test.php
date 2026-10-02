<?php
// Several dbspec document sets in one process, on SQLite, MySQL and
// PostgreSQL. The generated bench models (clients/php/gen) and the models of
// contracts/fixtures/decimal_schema.dbspec, generated into their own
// namespace, are loaded together; each model class carries the manifestHash
// of its own set, and any connection plans a request with the runtime model
// of the request's manifest hash. No registration call exists: a set that
// another connection installed is used by loading its generated models. A
// request whose manifest hash no loaded generated models registered, and
// generated code whose manifest text does not hash to its declared
// manifestHash, fail with SCHEMA_HASH_MISMATCH before execution. Each case
// runs in its own database (a new SQLite file, or a database the case creates
// on the server of ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN); the test fails
// when either variable is unset.
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

$benchDocuments = [(string) file_get_contents("$root/schema/bench.dbspec")];
$decimalDocuments = [(string) file_get_contents("$root/contracts/fixtures/decimal_schema.dbspec")];
$decimalModel = RuntimeModel::build(RuntimeModel::parse(['decimal_schema.dbspec' => $decimalDocuments[0]]));
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
 * bench set으로 시작한 연결이 bench와 decimal set을 설치하고(decimal은 두 번이며
 * 두 번째 설치는 아무것도 바꾸지 않는다) 두 set의 model을 transaction 안팎에서 쓴다.
 */
function severalSchemas(string $dsn): void
{
    global $benchDocuments, $decimalDocuments;
    $db = Orm::connect($dsn, new Config());
    try {
        foreach ([$benchDocuments, $decimalDocuments, $decimalDocuments] as $documents) {
            $db->utils()->schema()->install($documents);
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

/**
 * 다른 연결이 설치한 decimal set을 등록 호출 없이 쓴다. 설치 전에는 decimal
 * table이 없으므로 read가 DRIVER이고 아무것도 만들어지지 않는다. 설치 뒤에는
 * 먼저 열린 연결에서도 decimal model이 읽고 쓴다.
 */
function installedElsewhere(string $dsn): void
{
    global $benchDocuments, $decimalDocuments;
    $db = Orm::connect($dsn, new Config());
    try {
        check(code(fn() => (new DecimalCase)($db)->getCount()) === Code::DRIVER, 'decimal read before installation');
        check(code(fn() => (new DecimalCase)($db)->getCount()) === Code::DRIVER, 'the failed read created no table');
        $installer = Orm::connect($dsn, new Config());
        try {
            foreach ([$benchDocuments, $decimalDocuments] as $documents) {
                $installer->utils()->schema()->install($documents);
            }
        } finally {
            $installer->close();
        }
        (new DecimalCase)($db)->setSeq(3)->setAmount('2.5000')->create();
        $amount = (new DecimalCase)($db)->addAllColumns()->getBySeq(3)->getAmount();
        check($amount === '2.5000', "decimal row after installation elsewhere $amount");
    } finally {
        $db->close();
    }
}

/**
 * manifest text가 선언한 manifestHash로 hash되지 않는 generated model은
 * SCHEMA_HASH_MISMATCH로 실행 전에 거절되고 table은 바뀌지 않는다. 같은 hash의
 * engine이 이미 cache되어 있어도 그렇다.
 */
function editedManifest(string $dsn): void
{
    global $work, $decimalDocuments, $decimalModel;
    static $edits = 0;
    $db = Orm::connect($dsn, new Config());
    try {
        $db->utils()->schema()->install($decimalDocuments);
        // 진짜 decimal set의 engine을 먼저 cache한다.
        check((new DecimalCase)($db)->getCount() === 0, 'decimal read');
        $edited = str_replace('decimal(13,4)', 'decimal(14,4)', $decimalDocuments[0]);
        check($edited !== $decimalDocuments[0], 'edited manifest differs');
        $editedModel = RuntimeModel::build(RuntimeModel::parse(['decimal_schema.dbspec' => $edited]));
        $namespace = 'SchemaSetEdited' . (++$edits) . '\\Orm';
        $dir = "$work/edited-$edits";
        Generator::generate($editedModel, $dir, $namespace);
        // 편집한 text와 model은 그대로 두고 선언한 hash만 진짜 decimal set의 hash로 바꾼다.
        foreach (glob("$dir/*.php") as $file) {
            file_put_contents($file, str_replace($editedModel->manifestHash, $decimalModel->manifestHash, (string) file_get_contents($file)));
        }
        autoload($dir, $namespace);
        check(code(function () use ($dir): void {
            require "$dir/bootstrap.php";
        }) === Code::SCHEMA_HASH_MISMATCH, 'loading generated code of an edited manifest');
        $class = "$namespace\\DecimalCase";
        check($class::meta()['manifest_hash'] === $decimalModel->manifestHash, 'the edited model declares the decimal manifest hash');
        check(code(fn() => (new $class)($db)->setSeq(1)->setAmount('1.0000')->create()) === Code::SCHEMA_HASH_MISMATCH, 'write of the edited model');
        check(code(fn() => (new $class)($db)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'read of the edited model');
        check((new DecimalCase)($db)->getCount() === 0, 'decimal rows after the rejected requests');
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

/**
 * 어떤 generated code도 등록하지 않은 manifest hash를 싣는 요청은 table이
 * 있어도 SCHEMA_HASH_MISMATCH로 실행 전에 실패하며 다른 model이 plan하지 않는다.
 */
function unregisteredSchema(string $dsn): void
{
    global $work;
    static $sets = 0;
    $documents = ["dbspec 1 schema_set_unloaded\n\ntable schema_set_item {\n  seq i64 identity\n  label varchar(64)\n  primary key (seq)\n}\n"];
    $namespace = 'SchemaSetUnloaded' . (++$sets) . '\\Orm';
    $dir = "$work/unloaded-$sets";
    Generator::generate(RuntimeModel::build(RuntimeModel::parse(['unloaded.dbspec' => $documents[0]])), $dir, $namespace);
    // model class만 읽고 bootstrap.php는 읽지 않는다.
    autoload($dir, $namespace);
    $class = "$namespace\\SchemaSetItem";
    $db = Orm::connect($dsn, new Config());
    try {
        $db->utils()->schema()->install($documents);
        check(code(fn() => (new $class)($db)->addAllColumns()->gets()) === Code::SCHEMA_HASH_MISMATCH, 'read of an unregistered manifest');
        check(code(fn() => (new $class)($db)->setLabel('x')->create()) === Code::SCHEMA_HASH_MISMATCH, 'write of an unregistered manifest');
        $rows = (int) $db->pdo()->query('SELECT COUNT(*) FROM schema_set_item')->fetchColumn();
        check($rows === 0, "rows written by the rejected request: $rows");
    } finally {
        $db->close();
    }
}

$cases = [
    'several_schemas' => severalSchemas(...),
    'installed_elsewhere' => installedElsewhere(...),
    'edited_manifest' => editedManifest(...),
    'unregistered_schema' => unregisteredSchema(...),
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
