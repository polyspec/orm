<?php
// Several schemas on one connection, on SQLite, MySQL and PostgreSQL. The
// models of a core schema and a module schema are generated into separate
// namespaces and loaded in one process. A connection opened with the core
// schema installs both manifests and plans each model request with the
// engine of that model's schema. A connection that has not installed the
// module schema rejects a module model request with SCHEMA_HASH_MISMATCH, and
// install rejects a manifest whose hash differs from its content.
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name test databases; the test
// fails when either is unset.
// Usage: php clients/php/tests/schema_set_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use Orm\Code;
use Orm\Config;
use Orm\Generator;
use Orm\Manifest;
use Orm\Orm;
use Orm\OrmException;
use Orm\SchemaBuilder;
use SchemaSetCore\Orm\SchemaSetNote;
use SchemaSetModule\Orm\SchemaSetItem;

$work = sys_get_temp_dir() . '/orm-php-schema-set-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

/** Builds a manifest, writes it to $work/$name.json and generates its models into $namespace. */
function generated(string $work, string $name, string $source, string $namespace): string
{
    $json = SchemaBuilder::json(SchemaBuilder::fromSources([$source]));
    file_put_contents("$work/$name.json", $json);
    Generator::generate(Manifest::load($json), "$work/$name", $namespace);
    spl_autoload_register(static function (string $class) use ($work, $name, $namespace): void {
        if (str_starts_with($class, "$namespace\\")) {
            require "$work/$name/" . substr($class, strlen($namespace) + 1) . '.php';
        }
    });
    require "$work/$name/bootstrap.php";
    return $json;
}

$coreJson = generated($work, 'core', "erDiagram\n  schema_set_note {\n    bigint seq PK \"auto\"\n    varchar(64) title\n  }\n", 'SchemaSetCore\\Orm');
$moduleJson = generated($work, 'module', "erDiagram\n  schema_set_item {\n    bigint seq PK \"auto\"\n    varchar(64) label\n    int amount\n  }\n", 'SchemaSetModule\\Orm');
$corePath = "$work/core.json";

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

function code(callable $f): string
{
    try {
        $f();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return '';
}

function dropTables(string $dsn): void
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    foreach (['schema_set_item', 'schema_set_note'] as $table) {
        $pdo->exec("DROP TABLE IF EXISTS $table");
    }
}

/** A connection opened with the core schema serves the models of both schemas after installing them. */
function severalSchemas(string $dsn): void
{
    global $corePath, $coreJson, $moduleJson;
    $db = Orm::connect($dsn, new Config(schemaPath: $corePath));
    try {
        $db->utils()->schema()->install($coreJson);
        $db->utils()->schema()->install($moduleJson);
        // A repeated install keeps the tables and the registered engine.
        $db->utils()->schema()->install($moduleJson);
        (new SchemaSetNote)($db)->setTitle('core')->create();
        (new SchemaSetItem)($db)->setLabel('module')->setAmount(7)->create();
        $db->transaction(function () use ($db): void {
            (new SchemaSetNote)($db)->setTitle('core-tx')->create();
            (new SchemaSetItem)($db)->setLabel('module-tx')->setAmount(8)->create();
        }, retry: 0);
        $notes = array_map(static fn($n) => $n->getTitle(), array_values(iterator_to_array((new SchemaSetNote)($db)->addAllColumns()->orderBySeqAsc()->gets())));
        $items = array_map(static fn($i) => $i->getLabel() . ':' . $i->getAmount(), array_values(iterator_to_array((new SchemaSetItem)($db)->addAllColumns()->orderBySeqAsc()->gets())));
        check($notes === ['core', 'core-tx'], 'core rows ' . implode(',', $notes));
        check($items === ['module:7', 'module-tx:8'], 'module rows ' . implode(',', $items));
        check((new SchemaSetItem)($db)->amount(8)->getCount() === 1, 'module count');
    } finally {
        $db->close();
    }
}

/** A connection that has not installed the module schema rejects its models; no other engine plans them. */
function unregisteredSchema(string $dsn): void
{
    global $corePath, $coreJson, $moduleJson;
    $installer = Orm::connect($dsn, new Config(schemaPath: $corePath));
    try {
        $installer->utils()->schema()->install($coreJson);
        $installer->utils()->schema()->install($moduleJson);
    } finally {
        $installer->close();
    }
    $db = Orm::connect($dsn, new Config(schemaPath: $corePath));
    try {
        check(code(fn() => (new SchemaSetItem)($db)->addAllColumns()->gets()) === Code::SCHEMA_HASH_MISMATCH, 'module read before install');
        check(code(fn() => (new SchemaSetItem)($db)->setLabel('x')->setAmount(1)->create()) === Code::SCHEMA_HASH_MISMATCH, 'module write before install');
        check((new SchemaSetNote)($db)->getCount() === 0, 'core read');
        $db->utils()->schema()->install($moduleJson);
        check((new SchemaSetItem)($db)->getCount() === 0, 'module read after install');
    } finally {
        $db->close();
    }
}

/** Install verifies the manifest hash against its content before any statement runs. */
function editedManifest(string $dsn): void
{
    global $corePath, $moduleJson;
    $edited = str_replace('"schema_set_item"', '"schema_set_edit"', $moduleJson);
    check($edited !== $moduleJson, 'edited manifest differs');
    $db = Orm::connect($dsn, new Config(schemaPath: $corePath));
    try {
        check(code(fn() => $db->utils()->schema()->install($edited)) === Code::CONFIG, 'install of an edited manifest');
        check(code(fn() => (new SchemaSetItem)($db)->getCount()) === Code::SCHEMA_HASH_MISMATCH, 'edited manifest is not registered');
    } finally {
        $db->close();
    }
}

$cases = ['several_schemas' => severalSchemas(...), 'unregistered_schema' => unregisteredSchema(...), 'edited_manifest' => editedManifest(...)];
$selected = array_slice($argv, 1) ?: array_keys($cases);
$targets = ['sqlite' => "sqlite://$work/schema-set.sqlite"];
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
    $before = $failures;
    foreach ($targets as $driver => $dsn) {
        $current = "$case/$driver";
        $start = microtime(true);
        echo "RUN  $current\n";
        try {
            dropTables($dsn);
            $cases[$case]($dsn);
        } catch (Throwable $e) {
            $failures++;
            fwrite(STDERR, "FAIL $current: $e\n");
        } finally {
            dropTables($dsn);
        }
        printf("%s %s %.3fs\n", $failures === $before ? 'ok  ' : 'FAIL', $current, microtime(true) - $start);
    }
    if ($failures === $before) {
        echo "CASE $case PASS\n";
    }
}
if ($failures > 0) {
    fwrite(STDERR, "php schema set test: $failures failures\n");
    exit(1);
}
echo 'php schema set test: ' . count($selected) . ' cases on ' . count($targets) . " databases passed\n";
