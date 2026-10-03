<?php
// addColumns on SQLite, MySQL and PostgreSQL. A database holds the audit log
// tables of one manifest and the tables of a module manifest at version 1,
// with rows. addColumns with version 2 adds the missing nullable and
// defaulted columns to the existing module tables, keeps the rows, replaces
// the audit triggers of the changed table so that they record the new
// columns, creates no missing table and leaves the tables of the log manifest
// unchanged; a repeated call adds nothing. A manifest that differs from the
// tables in any other way fails with SCHEMA_DIFFERS before any change. The
// fixtures are contracts/fixtures/add_columns_*.json.
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name test databases; the test
// fails when either is unset.
// Usage: php clients/php/tests/add_columns_test.php [case ...]
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use AddColLog\Orm\AddcolChange;
use AddColLog\Orm\AddcolOperation;
use AddColV1\Orm\AddcolItem as ItemV1;
use AddColV1\Orm\AddcolTag as TagV1;
use AddColV2\Orm\AddcolExtra as ExtraV2;
use AddColV2\Orm\AddcolItem as ItemV2;
use AddColV2\Orm\AddcolTag as TagV2;
use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Generator;
use Orm\Manifest;
use Orm\Orm;
use Orm\OrmException;

$work = sys_get_temp_dir() . '/orm-php-add-columns-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$fixtures = dirname(__DIR__, 3) . '/contracts/fixtures';
/** @return string the manifest JSON of contracts/fixtures/add_columns_$name.json */
function fixture(string $name): string
{
    global $fixtures;
    $json = file_get_contents("$fixtures/add_columns_$name.json");
    if ($json === false) {
        throw new RuntimeException("fixture add_columns_$name.json is missing");
    }
    return $json;
}

foreach (['log' => 'AddColLog', 'v1' => 'AddColV1', 'v2' => 'AddColV2'] as $name => $prefix) {
    $namespace = "$prefix\\Orm";
    Generator::generate(Manifest::load(fixture($name)), "$work/$name", $namespace);
    spl_autoload_register(static function (string $class) use ($work, $name, $namespace): void {
        if (str_starts_with($class, "$namespace\\")) {
            require "$work/$name/" . substr($class, strlen($namespace) + 1) . '.php';
        }
    });
    require "$work/$name/bootstrap.php";
}
$logPath = "$fixtures/add_columns_log.json";
const ADDED = ['addcol_item.note', 'addcol_item.rank', 'addcol_item.archived', 'addcol_item.status', 'addcol_tag.color'];
const DIFFERS = ['required', 'removed', 'changed', 'nullable', 'default', 'index', 'unique'];

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
    [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    $pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    foreach (['addcol_extra', 'addcol_tag', 'addcol_item', 'addcol_change', 'addcol_operation'] as $table) {
        $pdo->exec("DROP TABLE IF EXISTS $table");
    }
    if ($driver === 'postgres') {
        $pdo->exec('DROP FUNCTION IF EXISTS addcol_item_audit()');
    }
}

/** Opens a connection with the log manifest and installs the log and version 1 with one item and one tag. */
function installed(string $dsn): Db
{
    global $logPath;
    $db = Orm::connect($dsn, new Config(schemaPath: $logPath));
    $db->utils()->schema()->install(fixture('log'));
    $db->utils()->schema()->install(fixture('v1'));
    $db->transaction(function () use ($db): void {
        (new AddcolOperation)($db)->setOperationUuid('op-1')->create();
        $db->utils()->setLocal('addcol.operation', 'op-1');
        $item = (new ItemV1)($db)->setUuid('item-1')->setLabel('first')->setEnabled(true)->setPrice('2.50')->create();
        (new TagV1)($db)->setAddcolItemSeq($item->getSeq())->setName('red')->create();
    }, retry: 0);
    return $db;
}

/** The after value of each audit change in order. */
function changes(Db $db): array
{
    $out = [];
    foreach ((new AddcolChange)($db)->addAllColumns()->orderBySeqAsc()->gets() as $row) {
        $out[] = $row->getChangeKind() . ' ' . \OrderedJson\stringify($row->getAfterValue()->payload());
    }
    return $out;
}

/**
 * addColumns adds the missing columns of the existing tables, keeps their rows,
 * makes the audit triggers record the new columns, creates no missing table,
 * leaves the log tables unchanged and adds nothing when repeated; install then
 * creates the missing table.
 */
function addColumns(string $dsn): void
{
    $db = installed($dsn);
    try {
        $before = changes($db);
        check(count($before) === 1, 'one change before: ' . implode(' | ', $before));
        $added = $db->utils()->schema()->addColumns(fixture('v2'));
        check($added === ADDED, 'added ' . implode(',', $added));
        $db->utils()->schema()->register(fixture('v2'));
        $items = iterator_to_array((new ItemV2)($db)->addAllColumns()->gets(), false);
        check(count($items) === 1, 'one item');
        $item = $items[0];
        check($item->getLabel() === 'first' && $item->getEnabled() === true && $item->getPrice() === '2.50', 'item values kept');
        check($item->getNote() === null && $item->getRank() === 3 && $item->getArchived() === false && $item->getStatus() === 'new', 'item defaults');
        $tags = iterator_to_array((new TagV2)($db)->addAllColumns()->gets(), false);
        check(count($tags) === 1 && $tags[0]->getName() === 'red' && $tags[0]->getColor() === null, 'tag values');
        check(changes($db) === $before, 'log rows kept');
        $db->transaction(function () use ($db, $item): void {
            (new AddcolOperation)($db)->setOperationUuid('op-2')->create();
            $db->utils()->setLocal('addcol.operation', 'op-2');
            $item->setNote('later')->setRank(4)->update();
        }, retry: 0);
        $after = changes($db);
        check(count($after) === 2 && $after[1] === 'UPDATE {"note":"later","rank":4}', 'update change ' . ($after[1] ?? ''));
        check(code(fn() => (new ExtraV2)($db)->getCount()) === Code::DRIVER, 'missing table is not created');
        check($db->utils()->schema()->addColumns(fixture('v2')) === [], 'repeated addColumns adds nothing');
        $db->utils()->schema()->install(fixture('v2'));
        check((new ExtraV2)($db)->getCount() === 0, 'install creates the missing table');
        check($db->utils()->schema()->addColumns(fixture('v2')) === [], 'addColumns after install adds nothing');
    } finally {
        $db->close();
    }
}

/** Every other difference fails with SCHEMA_DIFFERS before any change. */
function addColumnsDiffers(string $dsn): void
{
    $db = installed($dsn);
    try {
        foreach (DIFFERS as $name) {
            check(code(fn() => $db->utils()->schema()->addColumns(fixture($name))) === Code::SCHEMA_DIFFERS, "$name returns SCHEMA_DIFFERS");
        }
        check($db->utils()->schema()->addColumns(fixture('v2')) === ADDED, 'no column was added before');
    } finally {
        $db->close();
    }
}

/**
 * MySQL commits schema statements implicitly, so addColumns inside a
 * transaction returns CONFIG there; PostgreSQL and SQLite add the columns in
 * the active transaction, and its rollback removes them.
 */
function addColumnsTransaction(string $dsn): void
{
    $db = installed($dsn);
    try {
        if ($db->driver() === 'mysql') {
            check(code(fn() => $db->transaction(fn() => $db->utils()->schema()->addColumns(fixture('v2')), retry: 0)) === Code::CONFIG, 'MySQL transaction');
        } else {
            $error = '';
            try {
                $db->transaction(function () use ($db): void {
                    check($db->utils()->schema()->addColumns(fixture('v2')) === ADDED, 'added in the transaction');
                    throw new DomainException('roll back');
                }, retry: 0);
            } catch (DomainException $e) {
                $error = $e->getMessage();
            }
            check($error === 'roll back', 'callback error ' . $error);
        }
        check($db->utils()->schema()->addColumns(fixture('v2')) === ADDED, 'the transaction added no column');
    } finally {
        $db->close();
    }
}

/** addColumns verifies the manifest hash against its content before any statement runs. */
function addColumnsEditedManifest(string $dsn): void
{
    $db = installed($dsn);
    try {
        $edited = str_replace('"note"', '"memo"', fixture('v2'));
        check($edited !== fixture('v2'), 'edited manifest differs');
        check(code(fn() => $db->utils()->schema()->addColumns($edited)) === Code::CONFIG, 'edited manifest');
        check($db->utils()->schema()->addColumns(fixture('v2')) === ADDED, 'the edited manifest added no column');
    } finally {
        $db->close();
    }
}

$cases = ['add_columns' => addColumns(...), 'add_columns_differs' => addColumnsDiffers(...),
    'add_columns_transaction' => addColumnsTransaction(...), 'add_columns_edited_manifest' => addColumnsEditedManifest(...)];
$selected = array_slice($argv, 1) ?: array_keys($cases);
$targets = ['sqlite' => "sqlite://$work/add-columns.sqlite"];
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
    fwrite(STDERR, "php add columns test: $failures failures\n");
    exit(1);
}
echo 'php add columns test: ' . count($selected) . ' cases on ' . count($targets) . " databases passed\n";
