<?php

declare(strict_types=1);

// audit_triggers feature coverage: installs contracts/fixtures/audit_columns.dbs in the bench
// database and checks that the audit trigger records, for the insert, update, and soft delete the client writes,
// only the chosen columns. card uses exclude (secret) to leave out secret, and
// tag uses include (label) to record only label and the audit columns; the history table has
// only the columns it records. Both tables are written in an audit transaction on a connection with an audit source.
// Removes the installed tables and the PostgreSQL function at the end.
// The document's model is created in a temporary directory: one process holds one document set's
// model only.

require_once __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\CoverageAuditColumns\Card;
use Polyspec\Orm\Tests\CoverageAuditColumns\Tag;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\RuntimeModel;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

/** Reads from the catalog whether the connection's database has the table. */
function auditColumnsTable(Db $db, string $table): bool
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

/** Removes the installed table, and the PostgreSQL trigger function that is not removed with the table. */
function dropAuditColumns(Db $db): void
{
    $quote = $db->driver() === 'mysql' ? static fn(
        string $n
    ): string => "`$n`" : static fn(string $n): string => "\"$n\"";
    foreach (['card_history', 'card', 'tag_history', 'tag', 'audit'] as $table) {
        $db->pdo()->exec('DROP TABLE IF EXISTS ' . $quote($table));
    }
    if ($db->driver() === 'postgres') {
        foreach (['card', 'tag'] as $table) {
            foreach (['insert', 'update', 'delete'] as $event) {
                $db->pdo()->exec("DROP FUNCTION IF EXISTS \"$table\$audit_$event\"()");
            }
        }
    }
}

/**
 * Reads the column names and rows of a query as strings. NULL is 'NULL'.
 *
 * @return array{list<string>, list<list<string>>}
 */
function auditColumnsRows(Db $db, string $sql): array
{
    $st = $db->pdo()->query($sql);
    $columns = [];
    for ($i = 0; $i < $st->columnCount(); $i++) {
        $columns[] = $st->getColumnMeta($i)['name'];
    }
    $rows = array_map(
        static fn(array $r): array => array_map(static fn(mixed $v): string => $v === null ? 'NULL' : (string) $v, $r),
        $st->fetchAll(PDO::FETCH_NUM)
    );
    return [$columns, $rows];
}

/** Creates the document's model in $work, then runs install, write, history check, and cleanup. */
function auditColumnsCase(string $dsn, string $document, string $work): void
{
    Generator::generate(
        RuntimeModel::build(RuntimeModel::parse(['audit_columns.dbs' => $document])),
        "$work/gen",
        'Polyspec\\Orm\\Tests\\CoverageAuditColumns'
    );
    spl_autoload_register(static function (string $class) use ($work): void {
        if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\CoverageAuditColumns\\')) {
            require_once "$work/gen/" . substr($class, strlen('Polyspec\\Orm\\Tests\\CoverageAuditColumns\\')) . '.php';
        }
    });
    require_once "$work/gen/bootstrap.php";
    $db = Orm::connect($dsn, new Config(auditSource: static fn(): array => ['actor' => 'default']));
    try {
        coverageRestoring(function () use ($db): void {
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\CoverageAuditColumns\schema());
            $adb = $db;
            [$seq, $id] = $adb->transaction(function (): array {
                $seq = (new Card())->setTitle('first')->setSecret('s1')->create()->getSeq();
                $id = (new Tag())->setLabel('x')->setColor('red')->create()->getId();
                (new Card())->getBySeq($seq)->setTitle('second')->setSecret('s2')->update();
                return [$seq, $id];
            }, audit: ['actor' => 'first'], retry: 0);
            $adb->transaction(function () use ($seq, $id): void {
                (new Card())->getBySeq($seq)->delete();
                (new Tag())->getById($id)->setColor('blue')->update();
            }, audit: ['actor' => 'second'], retry: 0);
            $change = $db->driver() === 'mysql' ? '`change`' : '"change"';
            [$columns] = auditColumnsRows($db, 'SELECT * FROM card_history ORDER BY history_id');
            $want = ['history_id', 'change', 'previous_audit_seq', 'seq', 'title', 'audit_seq', 'deleted_at'];
            Assert::assertTrue(
                $columns === $want,
                'card_history columns ' . json_encode($columns) . ', want ' . json_encode($want)
            );
            [, $rows] = auditColumnsRows(
                $db,
                "SELECT $change, previous_audit_seq, seq, title, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM card_history ORDER BY history_id"
            );
            $want = [
                ['insert', 'NULL', "$seq", 'first', '1', 'live'],
                ['update', '1', "$seq", 'second', '1', 'live'],
                ['update', '1', "$seq", 'second', '2', 'deleted'],
            ];
            Assert::assertTrue($rows === $want, 'card_history ' . json_encode($rows) . ', want ' . json_encode($want));
            [$columns] = auditColumnsRows($db, 'SELECT * FROM tag_history ORDER BY history_id');
            $want = ['history_id', 'change', 'previous_audit_seq', 'label', 'audit_seq'];
            Assert::assertTrue(
                $columns === $want,
                'tag_history columns ' . json_encode($columns) . ', want ' . json_encode($want)
            );
            [, $rows] = auditColumnsRows(
                $db,
                "SELECT $change, previous_audit_seq, label, audit_seq FROM tag_history ORDER BY history_id"
            );
            $want = [['insert', 'NULL', 'x', '1'], ['update', '1', 'x', '2']];
            Assert::assertTrue($rows === $want, 'tag_history ' . json_encode($rows) . ', want ' . json_encode($want));
        }, fn() => dropAuditColumns($db));
        foreach (['audit', 'card', 'card_history', 'tag', 'tag_history'] as $table) {
            Assert::assertTrue(!auditColumnsTable($db, $table), "table $table remains after the case");
        }
    } finally {
        $db->close();
    }
}

#[Medium]
final class CoverageAuditColumnsTest extends TestCase
{
    // Requirements: DBS-85, DBS-88, DBS-93, DBS-94, DBS-96.
    public function test_audit_selected_columns(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $root = dirname(__DIR__, 3);
            $document = file_get_contents("$root/contracts/fixtures/audit_columns.dbs");
            if ($document === false) {
                throw new RuntimeException('cannot read contracts/fixtures/audit_columns.dbs');
            }
            $work = sys_get_temp_dir() . '/orm-php-coverage-audit-columns-' . getmypid();
            if (!mkdir($work, 0o700, true)) {
                throw new RuntimeException("cannot create $work");
            }
            try {
                auditColumnsCase($dsn, $document, $work);
            } finally {
                exec('rm -rf ' . escapeshellarg($work), $output, $status);
                if ($status !== 0) {
                    throw new RuntimeException("cannot remove $work");
                }
            }
        }
    }
}
