<?php

declare(strict_types=1);

// Scenario of a transaction that receives an audit record (same as auditCase in
// packages/go/orm/audit_transaction_test.go ). The owner case of RuntimeDbTest.php and the audit_history case of
// CoverageAuditTriggersTest.php both use it . The caller generates the model of contracts/fixtures/audit.dbs in
// $namespace and installs it on the connection.

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

/** The OrmException code thrown by $fn. 'no error' on success. */
function auditErrorCode(Closure $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

function auditWant(bool $ok, string $message): void
{
    \PHPUnit\Framework\Assert::assertTrue($ok, $message);
}

/** Reads all rows of the query as lists of strings. NULL is 'NULL'. @return list<list<string>> */
function auditTextRows(Db $db, string $sql): array
{
    $rows = $db->pdo()->query($sql)->fetchAll(PDO::FETCH_NUM);
    return array_map(
        static fn(array $r): array => array_map(static fn(mixed $v): string => $v === null ? 'NULL' : (string) $v, $r),
        $rows
    );
}

/**
 * Reads item_history's [change, previous, seq, title, audit, deleted] in history_id order. @return list<list<string>>
 */
function auditItemHistory(Db $db): array
{
    $change = $db->driver() === 'mysql' ? '`change`' : '"change"';
    return auditTextRows(
        $db,
        "SELECT $change, previous_audit_seq, seq, title, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' ELSE "
        . "'deleted' END FROM item_history ORDER BY history_id"
    );
}

/** The connection settings of an audit source that gives the actor as the audit value. */
function auditConfig(string $actor): Config
{
    return new Config(auditSource: static fn(): array => ['actor' => $actor]);
}

/**
 * Checks the writes of the transaction that receives audit records. $db is the connection opened with
 * auditConfig('default'), and $dsn is that database.
 * - The transaction inserts one record that combines the value the connection setting's audit source gives with the
 * transaction's audit value
 * into the audit setting's references table right before its first audited write (for the same column, the transaction
 * value
 *     wins), and the insert, update, and soft delete of the audit table write its primary key to the audit column.
 *     The trigger keeps each version in the history table, and previous is the audit key of the previous version.
 * - An audit transaction on a connection with no audit source, and a value that is not a column of the audit record
 * table (a value of the transaction or
 *     of the source) is CONFIG, and an exception the source throws is the transaction's exception.
 *   - A nested transaction uses the outer audit and does not take its own (CONFIG).
 * - An audit table write without audit is CONFIG. A raw write that points at a missing audit record is refused by the
 * foreign key
 *     refuses it.
 *   - If the callback fails, the audit record is rolled back too.
 */
function auditCase(Db $db, string $dsn, string $namespace): void
{
    $itemClass = "$namespace\\Item";
    $outside = auditErrorCode(fn() => (new $itemClass())($db)->setTitle('outside')->create());
    auditWant($outside === Code::CONFIG, "insert without an audit = $outside, want CONFIG");
    foreach (
        [
        'without an audit source' => new Config(),
        'with a source value that is no column' => new Config(auditSource: static fn(): array => ['reason' => 'x']),
        ] as $name => $config
    ) {
        $other = Orm::connectSchema($dsn, ("$namespace\\schema")(), $config);
        try {
            $code = auditErrorCode(fn() => $other->transaction(fn() => null, audit: ['actor' => 'x']));
        } finally {
            $other->close();
        }
        auditWant($code === Code::CONFIG, "an audit transaction of a connection $name = $code, want CONFIG");
    }
    $unavailable = new RuntimeException('no request');
    $failing = Orm::connectSchema(
        $dsn,
        ("$namespace\\schema")(),
        new Config(auditSource: static fn(): array => throw $unavailable)
    );
    try {
        $failing->transaction(fn() => null, audit: []);
        $thrown = null;
    } catch (Throwable $e) {
        $thrown = $e;
    } finally {
        $failing->close();
    }
    auditWant(
        $thrown === $unavailable,
        'an audit transaction whose source fails: ' . (
            $thrown?->getMessage() ?? 'no error'
        ) . ', want the source exception'
    );
    $adb = $db;
    $noColumn = auditErrorCode(fn() => $adb->transaction(fn() => null, audit: ['reason' => 'x']));
    auditWant($noColumn === Code::CONFIG, "an audit value that is no column = $noColumn, want CONFIG");

    $seq = $adb->transaction(function () use ($db, $adb, $itemClass): int {
        $seq = (new $itemClass())->setTitle('first')->create()->getSeq();
        $nested = auditErrorCode(fn() => $adb->transaction(fn() => null, audit: ['actor' => 'nested']));
        auditWant($nested === Code::CONFIG, "a nested transaction with an audit = $nested, want CONFIG");
        // A nested transaction writes the outer audit.
        $db->transaction(fn() => (new $itemClass())->setSeq($seq)->setTitle('second')->update(), retry: 0);
        return $seq;
    }, audit: ['actor' => 'create'], retry: 0);
    $third = auditErrorCode(fn() => (new $itemClass())($db)->setSeq($seq)->setTitle('third')->update());
    auditWant($third === Code::CONFIG, "update without an audit = $third, want CONFIG");
    // A transaction with no value records only the defaults.
    $adb->transaction(fn() => (new $itemClass())->setSeq($seq)->delete(), audit: [], retry: 0);
    $failed = new RuntimeException('callback failed');
    try {
        $adb->transaction(fn() => throw $failed, audit: ['actor' => 'rolled back'], retry: 0);
        throw new RuntimeException('the failed callback committed');
    } catch (RuntimeException $e) {
        auditWant($e === $failed, 'failed callback: ' . $e->getMessage());
    }

    try {
        $db->pdo()->exec("INSERT INTO item (title, audit_seq) VALUES ('raw', 999)");
        $rejected = false;
    } catch (PDOException) {
        $rejected = true;
    }
    auditWant($rejected, 'a raw insert that names no audit record succeeded; the foreign key rejects it');
    $records = auditTextRows($db, 'SELECT seq, actor FROM audit ORDER BY seq');
    auditWant($records === [['1', 'create'], ['2', 'default']], 'audit records ' . json_encode($records));
    $s = (string) $seq;
    $want = [
        ['insert', 'NULL', $s, 'first', '1', 'live'],
        ['update', '1', $s, 'second', '1', 'live'],
        ['update', '1', $s, 'second', '2', 'deleted'],
    ];
    $history = auditItemHistory($db);
    auditWant($history === $want, 'item_history ' . json_encode($history) . ', want ' . json_encode($want));
}
