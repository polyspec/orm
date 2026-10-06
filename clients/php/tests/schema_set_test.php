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
// loads. Each case runs in a case database of its own (case_database.php: a
// new SQLite file, or a database the case creates on the server of
// ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN); the test fails when either
// variable is unset.
// Usage: php clients/php/tests/schema_set_test.php [case ...]
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Tests\Model\User;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use Polyspec\Orm\Tests\SchemaSetDecimal\DecimalCase;

// CASE_DEADLINE_SECONDS는 case 하나의 기한이다. case 하나는 database를 만들고 schema set 몇 개를 설치하고 읽은 뒤 지운다.
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
Generator::generate($decimalModel, "$work/decimal", 'Polyspec\\Orm\\Tests\\SchemaSetDecimal');
autoload("$work/decimal", 'Polyspec\\Orm\\Tests\\SchemaSetDecimal');
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
 * bench helper로 연 연결이 bench와 decimal set을 설치하고(decimal은 두 번이며
 * 두 번째 설치는 아무것도 바꾸지 않는다) 두 set의 model을 transaction 안팎에서 쓴다.
 */
function severalSchemas(string $dsn): void
{
    $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
    try {
        foreach ([\Polyspec\Orm\Tests\Model\schema(), \Polyspec\Orm\Tests\SchemaSetDecimal\schema(), \Polyspec\Orm\Tests\SchemaSetDecimal\schema()] as $schema) {
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

/** 연결이 보낸 statement를 $n에 세는 subscriber를 등록하고 그 연결을 돌려준다. */
function counted(Db $db, int &$n): Db
{
    $db->subscribe(static function () use (&$n): void {
        $n++;
    });
    return $db;
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
    $raw = counted(Orm::connect($dsn, new Config()), $runs);
    try {
        check(code(fn() => (new User)($raw)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'bench read on a raw connection');
    } finally {
        $raw->close();
    }
    $core = counted(\Polyspec\Orm\Tests\Model\connect($dsn, new Config()), $runs);
    try {
        $installer = \Polyspec\Orm\Tests\SchemaSetDecimal\connect($dsn, new Config());
        try {
            $installer->utils()->schema()->install(\Polyspec\Orm\Tests\SchemaSetDecimal\schema());
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
    $decimal = \Polyspec\Orm\Tests\SchemaSetDecimal\connect($dsn, new Config());
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
    $db = counted(\Polyspec\Orm\Tests\SchemaSetDecimal\connect($dsn, new Config()), $runs);
    try {
        check(code(fn() => $db->utils()->schema()->install($edited)) === Code::CONFIG, 'install of an edited manifest');
        check($runs === 0, "the edited install ran $runs statements");
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\SchemaSetDecimal\schema());
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

/**
 * contracts/fixtures/external의 set을 생성하고 그 schema 값을 돌려준다(한 process에서 한 번). core는
 * ext_core를 소유한다. member는 ext_core의 ext_account와 ext_audit을 use로 쓰고 ext_post와
 * ext_post_history만 소유하며, member_v2는 summary column을 더하고, drifted는 외부 문서로
 * core_extra(database에 없는 column nick)를 쓴다.
 *
 * @return array{core: Schema, member: Schema, memberV2: Schema, drifted: Schema}
 */
function externalSets(): array
{
    global $root, $work;
    static $sets = null;
    if ($sets !== null) {
        return $sets;
    }
    $fixture = static fn(string $name): string => "$root/contracts/fixtures/external/$name.dbs";
    $built = [];
    foreach ([
        'core' => ['ExtCore', ['core'], []],
        'member' => ['ExtMember', ['member'], ['core']],
        'memberV2' => ['ExtMemberV2', ['member_v2'], ['core']],
        'drifted' => ['ExtDrifted', ['member'], ['core_extra']],
    ] as $key => [$prefix, $owned, $external]) {
        $model = RuntimeModel::build(RuntimeModel::files(array_map($fixture, $owned), array_map($fixture, $external)));
        $namespace = "$prefix\\Orm";
        Generator::generate($model, "$work/$prefix", $namespace);
        autoload("$work/$prefix", $namespace);
        require "$work/$prefix/bootstrap.php";
        $built[$key] = ("$namespace\\schema")();
    }
    return $sets = $built;
}

/**
 * 외부 문서를 쓰는 set(contracts/fixtures/external)을 dsn의 database에서 확인한다
 * (clients/go/orm/external_documents_test.go의 externalCase와 같다).
 *   - 외부 table이 없으면 install과 addTablesAndColumns가 어떤 statement보다 먼저 CONFIG이고
 *     member의 table을 만들지 않는다. 등록은 database를 읽지 않으므로 connectSchema는 외부
 *     table이 없거나 달라도 연결한다.
 *   - core를 설치한 뒤 member install은 소유한 table만 만들고, 다시 하면 아무것도 바꾸지 않는다.
 *     addTablesAndColumns는 소유한 table에만 column을 더한다.
 *   - member의 audit transaction은 core가 소유한 ext_audit에 기록을 삽입한다.
 *   - 외부 문서의 쓰는 table이 database와 다르면(없는 column) CONFIG다.
 */
function externalDocuments(string $dsn): void
{
    ['core' => $core, 'member' => $member, 'memberV2' => $memberV2, 'drifted' => $drifted] = externalSets();
    $config = new Config(auditSource: static fn(): array => ['actor' => 'writer']);
    $expectConfig = static function (string $step, callable $f, string $message): void {
        try {
            $f();
            check(false, "$step: no error, want CONFIG with $message");
        } catch (OrmException $e) {
            check($e->code_ === Code::CONFIG && str_contains($e->getMessage(), $message), "$step: {$e->code_} {$e->getMessage()}, want CONFIG with $message");
        }
    };
    $missing = 'the tables that the set uses from external documents differ from the database: table ext_account does not exist; table ext_audit does not exist';
    Orm::connectSchema($dsn, $member, $config)->close();

    $db = Orm::connect($dsn, $config);
    try {
        $schema = $db->utils()->schema();
        $exists = static function (string $table) use ($db): bool {
            try {
                $db->pdo()->query("SELECT COUNT(*) FROM $table")->fetchColumn();
                return true;
            } catch (PDOException) {
                return false;
            }
        };
        $expectConfig('install before core', static fn() => $schema->install($member), $missing);
        $expectConfig('addTablesAndColumns before core', static fn() => $schema->addTablesAndColumns($member), $missing);
        check(!$exists('ext_post'), 'ext_post exists after the refused install');

        $schema->install($core);
        $db->pdo()->exec("INSERT INTO ext_account (name) VALUES ('kim')");
        $schema->install($member);
        $schema->install($member);
        foreach (['ext_post', 'ext_post_history'] as $table) {
            check($exists($table), "$table does not exist after the member install");
        }
        Orm::connectSchema($dsn, $member, $config)->close();

        $db->transaction(fn() => (new \Polyspec\Orm\Tests\ExtMember\ExtPost)($db)->setAccountSeq(1)->setTitle('hello')->create(), audit: []);
        [$audit, $actor] = $db->pdo()->query('SELECT seq, actor FROM ext_audit')->fetch(PDO::FETCH_NUM);
        $recorded = $db->pdo()->query('SELECT audit_seq FROM ext_post_history')->fetchColumn();
        check($actor === 'writer' && (int) $recorded === (int) $audit, "audit record ($audit, $actor) and history audit $recorded, want the record of writer in the history");

        $added = $schema->addTablesAndColumns($member);
        check($added === [], 'addTablesAndColumns of the installed member: ' . json_encode($added) . ', want nothing');
        $added = $schema->addTablesAndColumns($memberV2);
        check($added === ['ext_post.summary', 'ext_post_history.summary'], 'addTablesAndColumns of member_v2: ' . json_encode($added));
        $accounts = (int) $db->pdo()->query('SELECT COUNT(*) FROM ext_account')->fetchColumn();
        check($accounts === 1, "ext_account has $accounts rows after the member changes, want 1");

        $differs = 'the tables that the set uses from external documents differ from the database: column ext_account.nick does not exist';
        Orm::connectSchema($dsn, $drifted, $config)->close();
        $expectConfig('install with a drifted external table', static fn() => $schema->install($drifted), $differs);
        $expectConfig('addTablesAndColumns with a drifted external table', static fn() => $schema->addTablesAndColumns($drifted), $differs);
    } finally {
        $db->close();
    }
}

/** 연결이 database에 보낸 statement, prepare, transaction 시작을 모두 센다. */
final class StatementCountingPdo extends PDO
{
    public int $sent = 0;

    public function exec(string $statement): int|false
    {
        $this->sent++;
        return parent::exec($statement);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $this->sent++;
        return parent::query($query, $fetchMode, ...$fetchModeArgs);
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->sent++;
        return parent::prepare($query, $options);
    }

    public function beginTransaction(): bool
    {
        $this->sent++;
        return parent::beginTransaction();
    }
}

/**
 * 등록은 database에 아무 statement도 보내지 않는다(docs/schema.md "Schema registration").
 * StatementCountingPdo로 연 연결에서 register는 외부 문서를 쓰는 set도 database를 읽지 않고,
 * 선언한 hash로 hash되지 않는 text는 statement 없이 CONFIG다. 등록한 bench set의 요청은 그
 * 연결에서 실행된다. connectSchema는 connect가 보내는 statement만 보낸다.
 */
function registerSendsNoStatement(string $dsn): void
{
    ['member' => $member] = externalSets();
    $installer = Orm::connect($dsn, new Config());
    try {
        $installer->utils()->schema()->install(\Polyspec\Orm\Tests\Model\schema());
    } finally {
        $installer->close();
    }
    [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $pdo = new StatementCountingPdo($pdoDsn, $user, $password);
    $db = new \Polyspec\Orm\Db($pdo, $driver, new Config(), new DateTimeZone('UTC'));
    try {
        check(code(fn() => (new User)($db)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'bench read before the register');
        $before = $pdo->sent;
        $db->utils()->schema()->register(\Polyspec\Orm\Tests\Model\schema());
        $db->utils()->schema()->register(\Polyspec\Orm\Tests\Model\schema());
        $db->utils()->schema()->register($member);
        $bench = \Polyspec\Orm\Tests\Model\schema();
        $edited = new Schema($bench->manifestText . "\n", $bench->manifestHash);
        check(code(fn() => $db->utils()->schema()->register($edited)) === Code::CONFIG, 'register of a text that does not hash to its declared hash');
        $sent = $pdo->sent - $before;
        check($sent === 0, "register sent $sent statements, want 0");
        $users = (new User)($db)->getCount();
        check($users === 0, "bench read after the register: $users rows");
    } finally {
        $db->close();
    }
    $runs = 0;
    counted(Orm::connect($dsn, new Config()), $runs)->close();
    $connectRuns = $runs;
    $runs = 0;
    counted(Orm::connectSchema($dsn, $member, new Config()), $runs)->close();
    check($runs === $connectRuns, "connectSchema ran $runs statements, connect $connectRuns");
}

/**
 * install은 table 이름만이 아니라 database 전체를 set과 비교한다(docs/schema.md "Schema
 * installation"). contracts/fixtures/install/changed_database.json의 case마다 statement로 ORM 밖에서
 * 바꾼 database에 같은 set을 다시 install하면 dialect의 message인 CONFIG이고 database는 그대로다.
 */
function installVerifiesTheDatabase(string $dsn): void
{
    global $root;
    $fixture = json_decode((string) file_get_contents("$root/contracts/fixtures/install/changed_database.json"), true, flags: JSON_THROW_ON_ERROR);
    check($fixture['cases'] !== [], 'contracts/fixtures/install/changed_database.json has no cases');
    [$driver] = Orm::parseDsn($dsn);
    foreach ($fixture['cases'] as $case) {
        check($case['operation'] === 'install', "{$case['id']}: the operation {$case['operation']}, want install");
        $document = (string) file_get_contents("$root/contracts/fixtures/{$case['document']}");
        $documents = RuntimeModel::parse([basename($case['document']) => $document]);
        $model = RuntimeModel::build($documents);
        $schema = new Schema($model->manifestText, $model->manifestHash);
        $db = Orm::connect($dsn, new Config());
        try {
            $db->utils()->schema()->install($schema);
            $db->pdo()->exec($case['statement']);
            $want = "{$case['expected']['code']}: {$case['expected']['message'][$driver]}";
            try {
                $db->utils()->schema()->install($schema);
                check(false, "{$case['id']}: install over the changed database: no error, want $want");
            } catch (OrmException $e) {
                check($e->code_ === $case['expected']['code'] && $e->getMessage() === $want, "{$case['id']}: install over the changed database: {$e->code_} {$e->getMessage()}, want $want");
            }
            $db->pdo()->query($case['remaining'])->fetchAll();
            // 다음 case는 같은 case database를 쓰므로 이 case의 table을 지운다.
            foreach ($documents as $parsed) {
                foreach ($parsed->tables as $table) {
                    $db->pdo()->exec("DROP TABLE {$table->name}");
                }
            }
        } finally {
            $db->close();
        }
    }
}

$cases = [
    'several_schemas' => severalSchemas(...),
    'unregistered_schema' => unregisteredSchema(...),
    'edited_manifest' => editedManifest(...),
    'external_documents' => externalDocuments(...),
    'register_sends_no_statement' => registerSendsNoStatement(...),
    'install_verifies_the_database' => installVerifiesTheDatabase(...),
];
$selected = array_slice($argv, 1) ?: array_keys($cases);
foreach ($selected as $case) {
    if (!isset($cases[$case])) {
        throw new RuntimeException("unknown case $case");
    }
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        $before = $failures;
        $current = "$case/$driver";
        $passed = testcase_run("schema_set/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($cases, $case, $driver, $before): void {
            with_case_database($driver, $step, static fn(string $dsn) => $cases[$case]($dsn));
            if ($GLOBALS['failures'] > $before) {
                throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
            }
        });
        if (!$passed && $failures === $before) {
            $failures++;
        }
    }
}
if ($failures > 0) {
    exit(1);
}
