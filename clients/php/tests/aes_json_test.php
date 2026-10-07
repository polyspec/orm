<?php
// Encrypted JSON value test on SQLite, MySQL and PostgreSQL: the
// `ordered_json aes` column of contracts/fixtures/secret_config.dbs takes an
// ordered-json value, reads it back with the same text, rotates to another key
// version, and takes an update. The models are generated from the document into
// a temporary directory, so the test runs in its own process.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when either
// is unset.
// Usage: php clients/php/tests/aes_json_test.php
declare(strict_types=1);

// bench model은 읽지 않는다: 이 test는 자기 document set의 model만 쓴다.
require dirname(__DIR__, 3) . '/vendor-php/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Tests\AesJson\SecretConfig;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\StyledValue;
use Polyspec\OrderedJson\Value;

use function Polyspec\OrderedJson\parse;
use function Polyspec\OrderedJson\stringify;

$work = sys_get_temp_dir() . '/orm-php-aes-json-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/secret_config.dbs')];
Generator::generate(RuntimeModel::build(RuntimeModel::parse(['secret_config.dbs' => $documents[0]])), "$work/gen", 'Polyspec\\Orm\\Tests\\AesJson');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\AesJson\\')) {
        require "$work/gen/" . substr($class, strlen('Polyspec\\Orm\\Tests\\AesJson\\')) . '.php';
    }
});
require "$work/gen/bootstrap.php";

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

function raw(string $dsn): PDO
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    return new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

/** @return array{string, int} the stored cell and key version of the single row */
function stored(string $dsn): array
{
    $row = raw($dsn)->query('SELECT config, aes_key_version FROM secret_config')->fetch(PDO::FETCH_NUM);
    $cell = is_resource($row[0]) ? (string) stream_get_contents($row[0]) : (string) $row[0];
    return [$cell, (int) $row[1]];
}

/** @param array<int, string> $keys */
function open(string $dsn, array $keys, int $version): Db
{
    return Orm::connectSchema($dsn, \Polyspec\Orm\Tests\AesJson\schema(), new Config(aesKey: $keys[$version], aesVersion: $version, aesKeys: $keys));
}

/** The ordered-json text of a read styled value; a value of another type fails the test. */
function text(mixed $value): string
{
    $payload = $value instanceof StyledValue ? $value->payload() : $value;
    if (!$payload instanceof Value) {
        throw new RuntimeException('json value is ' . get_debug_type($payload) . ', not an ordered-json value');
    }
    return stringify($payload);
}

function styled(mixed $value): StyledValue
{
    return StyledValue::value($value);
}

/** The OrmException code of json_encode($value), or 'no error'. */
function jsonEncodeCode(mixed $value): string
{
    try {
        json_encode($value, JSON_THROW_ON_ERROR);
    } catch (\Polyspec\Orm\OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

function aesJsonColumn(string $dsn): void
{
    global $documents;
    $value = '{"z":{"b":1,"a":[]},"a":[true,null,"x"],"token":"s3cret-token","n":-12.50,"e":{}}';
    $updated = '{"token":"next-token","list":[1,"two",null]}';
    $one = [1 => 'config-key-one'];
    $both = [1 => 'config-key-one', 2 => 'config-key-two'];

    $first = open($dsn, $one, 1);
    $first->utils()->schema()->install(\Polyspec\Orm\Tests\AesJson\schema());
    $seq = (new SecretConfig)($first)->setConfig(styled(parse($value)))->create()->getSeq();
    $row = (new SecretConfig)($first)->addAllColumns()->getBySeq($seq);
    check(text($row->getConfig()) === $value, 'read back');
    $array = $row->toArray()['config'];
    check($array['kind'] === 'value' && text($array['value']) === $value, 'toArray keeps the ordered-json value');
    $rowJson = '{"seq":' . $seq . ',"aes_key_version":1,"config":{"kind":"value","value":' . $value . '}}';
    check($row->toJson() === $rowJson, 'toJson keeps the member order and the number text: ' . $row->toJson());
    check(jsonEncodeCode($row) === 'CODEC_ENCODE', 'json_encode of a model with an ordered-json value fails');
    $rows = (new SecretConfig)($first)->addAllColumns()->seq($seq)->gets();
    check($rows->toJson() === '[' . $rowJson . ']', 'collection toJson');
    check(jsonEncodeCode($rows) === 'CODEC_ENCODE', 'json_encode of a collection with an ordered-json value fails');
    check((new SecretConfig)($first)->removeAllColumns()->addColumnSeq()->getBySeq($seq)->toJson() === '{"seq":' . $seq . '}'
        && json_encode((new SecretConfig)($first)->removeAllColumns()->addColumnSeq()->getBySeq($seq)) === '{"seq":' . $seq . '}', 'a row without an ordered-json value');
    $native = (new SecretConfig)($first)->setConfig(styled(['k' => [1, 2]]))->create()->getSeq();
    $read = (new SecretConfig)($first)->addAllColumns()->getBySeq($native);
    check(text($read->getConfig()) === '{"k":[1,2]}', 'native value write');
    (new SecretConfig)($first)->getBySeq($native)->delete();
    [$cell, $version] = stored($dsn);
    check(str_starts_with($cell, "ORM-AES2\0") && !str_contains($cell, 's3cret-token') && $version === 1, "stored version $version");
    $first->close();

    $second = open($dsn, $both, 2);
    check(text((new SecretConfig)($second)->addAllColumns()->getBySeq($seq)->getConfig()) === $value, 'mixed-version read');
    check($second->utils()->aes()->rotate(new SecretConfig, new AesKeyring($both, 2)) === 1, 'rotate');
    check(stored($dsn)[1] === 2, 'rotated version');
    $second->close();

    $rotated = open($dsn, [2 => 'config-key-two'], 2);
    check(text((new SecretConfig)($rotated)->addAllColumns()->getBySeq($seq)->getConfig()) === $value, 'rotated read');
    $rotated->close();

    $again = open($dsn, $both, 1);
    (new SecretConfig)($again)->getBySeq($seq)->setConfig(styled(parse($updated)))->update();
    check(stored($dsn)[1] === 1, 'updated version');
    check(text((new SecretConfig)($again)->addAllColumns()->getBySeq($seq)->getConfig()) === $updated, 'updated read');
    $again->close();
}

// 각 case는 자기 case database에 AES JSON column table을 만들고 row 몇 개를 쓰고 읽는다.
foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
    $current = "aes json column/$driver";
    $before = $failures;
    $passed = testcase_run("aes_json/$driver", TESTCASE_DATABASE, static function (callable $step) use ($driver, $before): void {
        with_case_database($driver, $step, static fn(string $dsn) => aesJsonColumn($dsn));
        if ($GLOBALS['failures'] > $before) {
            throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
        }
    });
    if (!$passed && $failures === $before) {
        $failures++;
    }
}
if ($failures > 0) {
    exit(1);
}
