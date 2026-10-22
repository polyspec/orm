<?php

declare(strict_types=1);

// audit_triggers feature coverage: installs contracts/fixtures/audit.dbs in the bench database
// and writes it in an audit transaction in the same order as auditCase in packages/go/orm/audit_transaction_test.go,
// checks the item_history and audit record left by the trigger, and removes the installed table and PostgreSQL
// function. soft_delete_restore does the same with contracts/fixtures/restore.dbs. The fixture's model
// is created per fixture in a temporary directory under its own namespace, and the bench model is not read.


use Polyspec\Orm\Tests\CoverageAudit\Item;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

/** Reads from the catalog whether the connection's database has the table. */
function auditTable(Db $db, string $table): bool
{
    $sql = match ($db->driver()) {
        'mysql' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        'postgres' => 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?',
        'sqlite' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
    };
    $st = $db->pdo()->prepare($sql);
    $st->execute([$table]);
    return (int) $st->fetchColumn() === 1;
}

/**
 * Removes the installed tables, starting with the table that points at the audit record table, and the
 * PostgreSQL trigger functions that are not removed with the table.
 *
 * @param list<string> $tables the tables, in the order to remove
 * @param list<string> $audited tables that have an audit trigger function
 */
function dropFixture(Db $db, array $tables, array $audited): void
{
    $quote = $db->driver() === 'mysql' ? static fn(
        string $n
    ): string => "`$n`" : static fn(string $n): string => "\"$n\"";
    foreach ($tables as $table) {
        $db->pdo()->exec('DROP TABLE IF EXISTS ' . $quote($table));
    }
    if ($db->driver() === 'postgres') {
        foreach ($audited as $table) {
            foreach (['insert', 'update', 'delete'] as $event) {
                $db->pdo()->exec("DROP FUNCTION IF EXISTS \"$table\$audit_$event\"()");
            }
        }
    }
}

/**
 * Creates the model of contracts/fixtures/<fixture>.dbs once in $namespace in a temporary directory and
 * registers it with autoload. Several cases in one process use the same model. The directory is removed when the
 * process ends.
 */
function fixtureModels(string $fixture, string $namespace): void
{
    static $generated = [];
    if (isset($generated[$fixture])) {
        return;
    }
    $root = dirname(__DIR__, 3);
    $document = file_get_contents("$root/contracts/fixtures/$fixture.dbs");
    if ($document === false) {
        throw new RuntimeException("cannot read contracts/fixtures/$fixture.dbs");
    }
    $work = sys_get_temp_dir() . "/orm-php-coverage-$fixture-" . getmypid();
    if (!mkdir($work, 0o700, true)) {
        throw new RuntimeException("cannot create $work");
    }
    $generated[$fixture] = $work;
    register_shutdown_function(static function () use ($work): void {
        exec('rm -rf ' . escapeshellarg($work), $output, $status);
        if ($status !== 0) {
            fwrite(STDERR, "cannot remove $work\n");
            exit(1);
        }
    });
    Generator::generate(
        RuntimeModel::build(RuntimeModel::parse(["$fixture.dbs" => $document])),
        "$work/gen",
        $namespace
    );
    spl_autoload_register(static function (string $class) use ($work, $namespace): void {
        if (str_starts_with($class, "$namespace\\")) {
            require_once "$work/gen/" . substr($class, strlen("$namespace\\")) . '.php';
        }
    });
    require_once "$work/gen/bootstrap.php";
}

/** Creates the model of the audit document in CoverageAudit\Orm. */
function auditModels(): void
{
    fixtureModels('audit', 'Polyspec\\Orm\\Tests\\CoverageAudit');
}

/** The table that the audit fixture creates. */
const AUDIT_TABLES = ['audit', 'item', 'item_history'];

/**
 * Connects with the audit source that gives the actor 'default' to the chosen database, installs the audit document,
 * runs $body($db, $dsn), and removes the installed tables and functions even if it fails.
 *
 * @param Closure(Db, string): void $body
 */
function withAudit(Closure $body): void
{
    [, $dsn] = coverageItem();
    auditModels();
    $db = Orm::connect($dsn, auditConfig('default'));
    try {
        foreach (AUDIT_TABLES as $table) {
            Assert::assertTrue(!auditTable($db, $table), "$table exists before the case");
        }
        coverageRestoring(function () use ($db, $dsn, $body): void {
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\CoverageAudit\schema());
            $body($db, $dsn);
        }, fn() => dropFixture($db, ['item_history', 'item', 'audit'], ['item']));
        foreach (AUDIT_TABLES as $table) {
            Assert::assertTrue(!auditTable($db, $table), "$table remains after the case");
        }
    } finally {
        $db->close();
    }
}

#[Medium]
final class CoverageAuditTriggersTest extends TestCase
{
    // The audit transaction inserts one audit record, and the write to the audit table writes its key (audit_case.php).
    // Requirements: CFG-8, DBS-87, DBS-88, DBS-89, DBS-93, DBS-117, DSL-118, DSL-126.
    public function testAuditHistory(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            withAudit(fn(Db $db, string $dsn) => auditCase($db, $dsn, 'Polyspec\\Orm\\Tests\\CoverageAudit'));
        }
    }

    // Every transaction entry point takes the audit values: PHP's entry point is one Db::transaction on a connection
    // with an audit source, and two transactions each insert one audit record, the audited write writes its key, and
    // nested transactions take no audit.
    // Requirements: CFG-8, DBS-87, DBS-88, DBS-93, DSL-126.
    public function testAuditTransactionEntryPoints(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            withAudit(function (Db $db): void {
                $adb = $db;
                $seq = $adb->transaction(
                    fn(): int => (new Item())->setTitle('first')->create()->getSeq(),
                    audit: ['actor' => 'transaction'],
                    retry: 0
                );
                $adb->transaction(
                    fn() => (new Item())($adb)->setSeq($seq)->setTitle('second')->update(),
                    audit: ['actor' => 'connected'],
                    retry: 0
                );
                $nested = auditErrorCode(
                    fn() => $adb->transaction(
                        fn() => $adb->transaction(fn() => null, audit: ['actor' => 'nested']),
                        audit: [],
                        retry: 0
                    )
                );
                Assert::assertTrue(
                    $nested === Code::CONFIG,
                    "a nested transaction with an audit is $nested, want CONFIG"
                );
                $s = (string) $seq;
                $history = auditItemHistory($db);
                $want = [
                    ['insert', 'NULL', $s, 'first', '1', 'live'],
                    ['update', '1', $s, 'second', '2', 'live'],
                ];
                Assert::assertTrue(
                    $history === $want,
                    'history ' . json_encode($history) . ', want ' . json_encode($want)
                );
                $records = auditTextRows($db, 'SELECT seq, actor FROM audit ORDER BY seq');
                Assert::assertTrue(
                    $records === [['1', 'transaction'], ['2', 'connected']],
                    'audit records ' . json_encode($records)
                );
            });
        }
    }

    // Restores a soft-deleted row with restore (restore_case.php): an audit table with a unique key and exclude list,
    // and a table without audit. At the end it removes the installed tables and PostgreSQL trigger functions.
    // Requirements: DBS-67, DBS-87, DBS-88, DBS-93, DBS-96, DBS-117, DIA-161, INT-38.
    public function testSoftDeleteRestore(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            fixtureModels('restore', 'Polyspec\\Orm\\Tests\\CoverageRestore');
            $tables = ['audit', 'label', 'membership', 'membership_history'];
            $db = Orm::connect($dsn, auditConfig('default'));
            try {
                foreach ($tables as $table) {
                    Assert::assertTrue(!auditTable($db, $table), "$table exists before the case");
                }
                coverageRestoring(function () use ($db): void {
                    $db->utils()->schema()->install(\Polyspec\Orm\Tests\CoverageRestore\schema());
                    restoreCase($db, 'Polyspec\\Orm\\Tests\\CoverageRestore');
                }, fn() => dropFixture($db, ['membership_history', 'membership', 'label', 'audit'], ['membership']));
                foreach ($tables as $table) {
                    Assert::assertTrue(!auditTable($db, $table), "$table remains after the case");
                }
            } finally {
                $db->close();
            }
        }
    }
}
