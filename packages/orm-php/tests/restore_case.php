<?php
declare(strict_types=1);
// contracts/fixtures/restore.dbs의 restore scenario(packages/orm-go/orm/restore_test.go의 restoreCase와
// 같다). runtime_db_test.php의 owner case와 coverage_audit_triggers.php의 soft_delete_restore case가
// 함께 쓴다. 호출자는 fixture의 model을 $namespace에 생성하고 연결에 설치한다.

use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

/** $fn이 던진 OrmException의 code다. 성공하면 'no error'다. */
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
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

/**
 * soft delete한 행을 restore로 되돌린다. membership은 unique key (team_id, member_id)와 exclude (note)를
 * 가진 audit table이고 label은 unique key (name)를 가진 audit 없는 table이다. 확인하는 것:
 * soft delete한 행의 unique key 값은 남아 같은 key의 insert는 DUPLICATE_KEY다. 기본 read는 지운 행을
 * 읽지 않는다. restore는 primary key나 unique key 하나의 set 값으로 지운 행을 찾아 soft delete column을
 * NULL로 쓰는 update를 하고 되돌린 행을 돌려준다. key 밖의 set 값은 그 update가 함께 쓰는 새 값이다. audit table이면 transaction의 audit 기록 key를 쓰고
 * trigger가 그 update를 기록하며, audit이 없으면 CONFIG다. 지워지지 않은 행의 restore는 아무것도
 * 쓰지 않고(새 값도 쓰지 않는다) 그 행을 돌려주고, 없는 행의 restore는 NO_ROWS다. key의 값이 없는
 * restore는 CONFIG다.
 */
function restoreCase(Db $db, string $namespace): void
{
    $membershipClass = "$namespace\\Membership";
    $labelClass = "$namespace\\Label";
    $membership = static fn() => (new $membershipClass)($db);
    $label = static fn() => (new $labelClass)($db);
    // audit 기록의 key는 실패한 transaction이 쓴 번호를 database마다 다르게 건너뛸 수 있으므로 actor로
    // 찾는다.
    $auditSeq = static function (string $actor) use ($db): string {
        $st = $db->pdo()->prepare('SELECT seq FROM audit WHERE actor = ?');
        $st->execute([$actor]);
        $rows = $st->fetchAll(PDO::FETCH_COLUMN);
        restoreWant(count($rows) === 1, "audit records of $actor " . json_encode($rows) . ', want one');
        return (string) $rows[0];
    };
    // $db는 actor 'default'를 주는 audit source로 연 연결이다.
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
    $hidden = restoreErrorCode(fn() => $label()->getByName('red'));
    restoreWant($hidden === Code::NO_ROWS, "default read of a soft-deleted row = $hidden, want NO_ROWS");
    $outside = restoreErrorCode(fn() => $membership()->setTeamId(1)->setMemberId(2)->restore());
    restoreWant($outside === Code::CONFIG, "restore of an audited row without an audit = $outside, want CONFIG");

    $values = static function (array $row): array {
        ksort($row);
        return $row;
    };
    // key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이다.
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
    restoreWant($nonKey === Code::CONFIG, "restore without the values of a key = $nonKey, want CONFIG");
    $empty = restoreErrorCode(fn() => $label()->restore());
    restoreWant($empty === Code::CONFIG, "restore without key values = $empty, want CONFIG");

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
