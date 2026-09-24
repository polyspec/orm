<?php
// Audit service value test on SQLite, MySQL and PostgreSQL: the change table's
// service column is bigint, an audited entity with service= records its bigint
// value, an entity without it records NULL, and an enum column with a default
// installs on every database. The models are generated from the test schema
// into a temporary directory, so the test runs in its own process.
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name empty test databases; the
// test fails when either is unset.
// Usage: php clients/php/tests/audit_service_test.php
declare(strict_types=1);

// The bench models are not loaded: one process holds the models of one schema.
require dirname(__DIR__) . '/vendor/autoload.php';

use AuditService\Orm\AuditChange;
use AuditService\Orm\AuditOperation;
use AuditService\Orm\Routed;
use AuditService\Orm\Unowned;
use Orm\Config;
use Orm\Generator;
use Orm\Manifest;
use Orm\Orm;
use Orm\SchemaBuilder;

$work = sys_get_temp_dir() . '/orm-php-audit-service-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$source = "erDiagram\n"
    . "  audit_operation {\n    bigint seq PK \"auto\"\n    varchar(36) operation_uuid UK\n  }\n"
    . "  audit_change {\n    bigint seq PK \"auto\"\n    bigint operation_seq\n    varchar(16) change_kind\n    bigint service_seq \"?\"\n"
    . "    varchar(191) table_label\n    jsontext entity_ref\n    jsontext before_value\n    jsontext after_value\n  }\n"
    . "  routed {\n    bigint seq PK \"auto\"\n    bigint service_seq\n    enum(csr_ssr) render \"=ssr\"\n  }\n"
    . "  unowned {\n    bigint seq PK \"auto\"\n    varchar(32) label\n  }\n"
    . "  %% orm:audit_log operation=audit_operation(seq, operation_uuid) context=app.operation_id change=audit_change(operation_seq, change_kind, service_seq, table_label, entity_ref, before_value, after_value)\n"
    . "  %% orm:audit entity=routed mode=changes service=service_seq\n"
    . "  %% orm:audit entity=unowned mode=changes\n";
$schema = "$work/schema.json";
$json = SchemaBuilder::json(SchemaBuilder::fromSources([$source]));
file_put_contents($schema, $json);
Generator::generate(Manifest::load($json), "$work/gen", 'AuditService\\Orm');
spl_autoload_register(static function (string $class) use ($work): void {
    if (str_starts_with($class, 'AuditService\\Orm\\')) {
        require "$work/gen/" . substr($class, strlen('AuditService\\Orm\\')) . '.php';
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

function dropTables(string $dsn): void
{
    [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    foreach (['routed', 'unowned', 'audit_change', 'audit_operation'] as $table) {
        $pdo->exec("DROP TABLE IF EXISTS $table");
    }
}

function auditBigintService(string $dsn): void
{
    global $schema, $json;
    dropTables($dsn);
    $db = Orm::connect($dsn, new Config(schemaPath: $schema));
    $db->utils()->schema()->install($json);
    $db->transaction(function () use ($db): void {
        (new AuditOperation)($db)->setOperationUuid('op-1')->create();
        $db->utils()->setLocal('app.operation_id', 'op-1');
        (new Routed)($db)->setServiceSeq(42)->create();
        (new Unowned)($db)->setLabel('a')->create();
    }, retry: 0);
    $got = [];
    $rows = [];
    foreach ((new AuditChange)($db)->addAllColumns()->orderBySeqAsc()->gets() as $row) {
        $rows[] = $row;
        $got[] = $row->getTableLabel() . ':' . ($row->getServiceSeq() ?? 'null');
    }
    check($got === ['routed:42', 'unowned:null'], 'changes ' . implode(',', $got));
    check(str_contains(\OrderedJson\stringify($rows[0]->getAfterValue()), '"render":"ssr"'), 'render default');
    $db->close();
    dropTables($dsn);
}

$targets = ['sqlite' => "sqlite://$work/audit-service.sqlite"];
foreach (['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'] as $driver => $env) {
    $v = getenv($env);
    if ($v === false || $v === '') {
        throw new RuntimeException("$env is required; database tests never skip");
    }
    $targets[$driver] = $v;
}
foreach ($targets as $driver => $dsn) {
    $current = "audit bigint service/$driver";
    try {
        auditBigintService($dsn);
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}
if ($failures > 0) {
    fwrite(STDERR, "php audit service test: $failures failures\n");
    exit(1);
}
echo 'php audit service test: ' . count($targets) . " databases passed\n";
