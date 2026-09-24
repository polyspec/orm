<?php
// Encrypted JSON value test on SQLite, MySQL and PostgreSQL: a `json aes` column
// and a jsontext column take an ordered-json value, read it back with the same
// text, rotate to another key version, and take an update. The models are generated from the test schema into a
// temporary directory, so the test runs in its own process.
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name empty test databases; the
// test fails when either is unset.
// Usage: php clients/php/tests/aes_json_test.php
declare(strict_types=1);

// The bench models are not loaded: one process holds the models of one schema.
require dirname(__DIR__) . '/vendor/autoload.php';

use AesJson\Orm\SecretConfig;
use Orm\AesKeyring;
use Orm\Config;
use Orm\Db;
use Orm\Generator;
use Orm\Manifest;
use Orm\Orm;
use Orm\SchemaBuilder;
use OrderedJson\Value;

use function OrderedJson\parse;
use function OrderedJson\stringify;

$work = sys_get_temp_dir() . '/orm-php-aes-json-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$source = "erDiagram\n"
    . "  secret_config {\n"
    . "    bigint   seq             PK \"auto\"\n"
    . "    int      aes_key_version\n"
    . "    longblob config             \"json aes\"\n"
    . "    jsontext doc                \"?\"\n"
    . "  }\n";
$schema = "$work/schema.json";
$json = SchemaBuilder::json(SchemaBuilder::fromSources([$source]));
file_put_contents($schema, $json);
Generator::generate(Manifest::load($json), "$work/gen", 'AesJson\\Orm');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'AesJson\\Orm\\')) {
        require "$work/gen/" . substr($class, strlen('AesJson\\Orm\\')) . '.php';
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
    global $schema;
    return Orm::connect($dsn, new Config(schemaPath: $schema, aesKey: $keys[$version], aesVersion: $version, aesKeys: $keys));
}

/** The ordered-json text of a read value; a value of another type fails the test. */
function text(mixed $value): string
{
    if (!$value instanceof Value) {
        throw new RuntimeException('json value is ' . get_debug_type($value) . ', not an ordered-json value');
    }
    return stringify($value);
}

/** The OrmException code of json_encode($value), or 'no error'. */
function jsonEncodeCode(mixed $value): string
{
    try {
        json_encode($value, JSON_THROW_ON_ERROR);
    } catch (\Orm\OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

function aesJsonColumn(string $dsn): void
{
    global $json;
    $pdo = raw($dsn);
    $pdo->exec('DROP TABLE IF EXISTS secret_config');
    $value = '{"z":{"b":1,"a":[]},"a":[true,null,"x"],"token":"s3cret-token","n":-12.50,"e":{}}';
    $doc = '{"b":1,"a":[],"c":{},"n":1.50}';
    $updated = '{"token":"next-token","list":[1,"two",null]}';
    $one = [1 => 'config-key-one'];
    $both = [1 => 'config-key-one', 2 => 'config-key-two'];

    $first = open($dsn, $one, 1);
    $first->utils()->schema()->install($json);
    $seq = (new SecretConfig)($first)->setConfig(parse($value))->setDoc(parse($doc))->create()->getSeq();
    $row = (new SecretConfig)($first)->addAllColumns()->getBySeq($seq);
    check(text($row->getConfig()) === $value, 'read back');
    check(text($row->getDoc()) === $doc, 'jsontext read back');
    check(text($row->toArray()['doc']) === $doc, 'toArray keeps the ordered-json value');
    $rowJson = '{"seq":' . $seq . ',"config":' . $value . ',"doc":' . $doc . '}';
    check($row->toJson() === $rowJson, 'toJson keeps the member order and the number text');
    check(jsonEncodeCode($row) === 'CODEC_ENCODE', 'json_encode of a model with an ordered-json value fails');
    $rows = (new SecretConfig)($first)->addAllColumns()->seq($seq)->gets();
    check($rows->toJson() === '[' . $rowJson . ']', 'collection toJson');
    check(jsonEncodeCode($rows) === 'CODEC_ENCODE', 'json_encode of a collection with an ordered-json value fails');
    check((new SecretConfig)($first)->removeAllColumns()->addColumnSeq()->getBySeq($seq)->toJson() === '{"seq":' . $seq . '}'
        && json_encode((new SecretConfig)($first)->removeAllColumns()->addColumnSeq()->getBySeq($seq)) === '{"seq":' . $seq . '}', 'a row without an ordered-json value');
    $native = (new SecretConfig)($first)->setConfig(['k' => [1, 2]])->setDoc(['a' => 1.5])->create()->getSeq();
    $read = (new SecretConfig)($first)->addAllColumns()->getBySeq($native);
    check(text($read->getConfig()) === '{"k":[1,2]}' && text($read->getDoc()) === '{"a":1.5}', 'native value write');
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
    (new SecretConfig)($again)->getBySeq($seq)->setConfig(parse($updated))->update();
    check(stored($dsn)[1] === 1, 'updated version');
    check(text((new SecretConfig)($again)->addAllColumns()->getBySeq($seq)->getConfig()) === $updated, 'updated read');
    $again->close();
    $pdo->exec('DROP TABLE IF EXISTS secret_config');
}

$targets = ['sqlite' => "sqlite://$work/aes-json.sqlite"];
foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $env) {
    $v = getenv($env);
    if ($v === false || $v === '') {
        throw new RuntimeException("$env is required; database tests never skip");
    }
    $targets[$driver] = $v;
}
foreach ($targets as $driver => $dsn) {
    $current = "aes json column/$driver";
    try {
        aesJsonColumn($dsn);
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}
if ($failures > 0) {
    fwrite(STDERR, "php aes json test: $failures failures\n");
    exit(1);
}
echo 'php aes json test: ' . count($targets) . " databases passed\n";
