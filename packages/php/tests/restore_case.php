<?php
declare(strict_types=1);
// The restore scenario of contracts/fixtures/restore.dbs (same as restoreCase in packages/go/orm/restore_test.go
// ). The owner case of RuntimeDbTest.php and the soft_delete_restore case of CoverageAuditTriggersTest.php both use it
// . The caller generates the fixture's model in $namespace and installs it on the connection.

use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

/** The OrmException code thrown by $fn. 'no error' on success. */
function restoreErrorCode(Closure $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

function restoreWant(bool $ok, string $message): void
{
    \PHPUnit\Framework\Assert::assertTrue($ok, $message);
}

/**
 * Restores the soft-deleted row with restore. membership is an audit table with the unique key (team_id, member_id) and the exclude (note),
 * and label is a table with no audit that has the unique key (name). Checks:
 * the unique key values of the soft-deleted row remain, so an insert with the same key is DUPLICATE_KEY. The default read does not read deleted rows.
 * restore sends only the set values. It finds the deleted row by the set value of one primary key or unique key the planner chose, and sets the soft delete column
 * to NULL in an update, and returns the restored row. The set values outside the key are new values that the update writes together. For an audit table it uses the transaction's audit record key, and
 * the trigger records that update; without audit it is CONFIG. A restore of a row that is not deleted writes nothing
 * (not even new values) and returns that row, and restoring a missing row is NO_ROWS. A restore whose key values are missing
 * is IR_INVALID with no statement.
 */
function restoreCase(Db $db, string $namespace): void
{
    $membershipClass = "$namespace\\Membership";
    $labelClass = "$namespace\\Label";
    $membership = static fn() => (new $membershipClass)($db);
    $label = static fn() => (new $labelClass)($db);
    // The audit record key may skip, in each database, a number that the failed transaction wrote, so it is found by the actor
    // instead.
    $auditSeq = static function (string $actor) use ($db): string {
        $st = $db->pdo()->prepare('SELECT seq FROM audit WHERE actor = ?');
        $st->execute([$actor]);
        $rows = $st->fetchAll(PDO::FETCH_COLUMN);
        restoreWant(count($rows) === 1, "audit records of $actor " . json_encode($rows) . ', want one');
        return (string) $rows[0];
    };
    // $db is the connection opened with an audit source that gives the actor 'default'.
    $adb = $db;
    [$seq, $id] = $adb->transaction(function () use ($membershipClass, $labelClass): array {
        $seq = (new $membershipClass)->setTeamId(1)->setMemberId(2)->setNote('n1')->create()->getSeq();
        $id = (new $labelClass)->setName('red')->setColor('x')->create()->getId();
        return [$seq, $id];
    }, audit: ['actor' => 'create'], retry: 0);
    $adb->transaction(function () use ($membershipClass, $labelClass, $seq, $id): void {
        (new $membershipClass)->setSeq($seq)->delete();
        (new $labelClass)->setId($id)->delete();
    }, audit: ['actor' => 'delete'], retry: 0);

    $duplicate = restoreErrorCode(fn() => $adb->transaction(fn() => (new $membershipClass)->setTeamId(1)->setMemberId(2)->create(), audit: ['actor' => 'duplicate'], retry: 0));
    restoreWant($duplicate === Code::DUPLICATE_KEY, "insert of the key of a soft-deleted row = $duplicate, want DUPLICATE_KEY");
    $hidden = $label()->getByName('red');
    restoreWant($hidden === null, 'default read of a soft-deleted row is not null, want null');
    $outside = restoreErrorCode(fn() => $membership()->setTeamId(1)->setMemberId(2)->restore());
    restoreWant($outside === Code::CONFIG, "restore of an audited row without an audit = $outside, want CONFIG");

    $values = static function (array $row): array {
        ksort($row);
        return $row;
    };
    // A set value outside the key is a new value written together with the restored row.
    $restored = $adb->transaction(fn() => (new $membershipClass)->setTeamId(1)->setMemberId(2)->setNote('n2')->restore(), audit: ['actor' => 'restore'], retry: 0);
    $want = $values(['seq' => $seq, 'team_id' => 1, 'member_id' => 2, 'note' => 'n2', 'audit_seq' => (int) $auditSeq('restore'), 'deleted_at' => null]);
    restoreWant($values($restored->toArray()) === $want, 'restored membership ' . json_encode($restored->toArray()) . ', want ' . json_encode($want));
    $again = $adb->transaction(fn() => (new $membershipClass)->setSeq($seq)->setNote('n3')->restore(), audit: ['actor' => 'again'], retry: 0);
    restoreWant($values($again->toArray()) === $want, 'restore of a row that is not deleted ' . json_encode($again->toArray()) . ', want the unchanged row');

    $restoredLabel = $label()->setName('red')->setColor('y')->restore();
    $wantLabel = $values(['id' => $id, 'name' => 'red', 'color' => 'y', 'deleted_at' => null]);
    restoreWant($values($restoredLabel->toArray()) === $wantLabel, 'restored label ' . json_encode($restoredLabel->toArray()) . ', want ' . json_encode($wantLabel));
    $missing = restoreErrorCode(fn() => $label()->setName('blue')->restore());
    restoreWant($missing === Code::NO_ROWS, "restore of an absent row = $missing, want NO_ROWS");
    $nonKey = restoreErrorCode(fn() => $label()->setColor('x')->restore());
    restoreWant($nonKey === Code::IR_INVALID, "restore without the values of a key = $nonKey, want IR_INVALID");
    $empty = restoreErrorCode(fn() => $label()->restore());
    restoreWant($empty === Code::IR_INVALID, "restore without key values = $empty, want IR_INVALID");

    $change = $db->driver() === 'mysql' ? '`change`' : '"change"';
    $rows = $db->pdo()->query("SELECT $change, previous_audit_seq, seq, team_id, member_id, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM membership_history ORDER BY history_id")->fetchAll(PDO::FETCH_NUM);
    $history = array_map(static fn(array $r): array => array_map(static fn(mixed $v): string => $v === null ? 'NULL' : (string) $v, $r), $rows);
    $s = (string) $seq;
    $wantHistory = [
        ['insert', 'NULL', $s, '1', '2', $auditSeq('create'), 'live'],
        ['update', $auditSeq('create'), $s, '1', '2', $auditSeq('delete'), 'deleted'],
        ['update', $auditSeq('delete'), $s, '1', '2', $auditSeq('restore'), 'live'],
    ];
    restoreWant($history === $wantHistory, 'membership_history ' . json_encode($history) . ', want ' . json_encode($wantHistory));
    $live = (int) $db->pdo()->query('SELECT COUNT(*) FROM label WHERE deleted_at IS NULL')->fetchColumn();
    restoreWant($live === 1, "live labels $live, want 1");
    $failedAudits = (int) $db->pdo()->query("SELECT COUNT(*) FROM audit WHERE actor = 'duplicate'")->fetchColumn();
    restoreWant($failedAudits === 0, "audit records of the failed transaction $failedAudits, want 0");
}
