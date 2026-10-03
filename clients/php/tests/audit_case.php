<?php
declare(strict_types=1);
// audit 기록을 받은 transaction의 scenario(clients/go/orm/audit_transaction_test.go의 auditCase와
// 같다). runtime_db_test.php의 owner case와 coverage_audit_triggers.php의 audit_history case가 함께
// 쓴다. 호출자는 contracts/fixtures/audit.dbs의 model을 $namespace에 생성하고 연결에 설치한다.

use Orm\Code;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\OrmException;

/** $fn이 던진 OrmException의 code다. 성공하면 'no error'다. */
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
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

/** query의 모든 row를 문자열 목록으로 읽는다. NULL은 'NULL'이다. @return list<list<string>> */
function auditTextRows(Db $db, string $sql): array
{
    $rows = $db->pdo()->query($sql)->fetchAll(PDO::FETCH_NUM);
    return array_map(static fn(array $r): array => array_map(static fn(mixed $v): string => $v === null ? 'NULL' : (string) $v, $r), $rows);
}

/** item_history의 [change, previous, seq, title, audit, deleted]를 history_id 순서로 읽는다. @return list<list<string>> */
function auditItemHistory(Db $db): array
{
    $change = $db->driver() === 'mysql' ? '`change`' : '"change"';
    return auditTextRows($db, "SELECT $change, previous_audit_seq, seq, title, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM item_history ORDER BY history_id");
}

/** actor를 audit 값으로 주는 audit source를 가진 연결 설정이다. */
function auditConfig(string $actor): Config
{
    return new Config(auditSource: static fn(): array => ['actor' => $actor]);
}

/**
 * audit 기록을 받은 transaction의 write를 확인한다. $db는 auditConfig('default')로 연 연결이고 $dsn은
 * 그 database다.
 *   - 연결 설정의 audit source가 준 값과 transaction의 audit 값을 합친 기록 하나를 transaction이
 *     callback 전에 audit setting의 references table에 삽입하고(같은 column이면 transaction 값이
 *     이긴다), audit table의 insert, update, soft delete는 그 primary key를 audit column에 쓴다.
 *     trigger가 각 version을 history table에 남기고 previous는 이전 version의 audit key다.
 *   - audit source가 없는 연결의 audit transaction, audit 기록 table의 column이 아닌 값(transaction이나
 *     source의 값)은 CONFIG이고, source가 던진 예외는 transaction의 예외다.
 *   - 중첩 transaction은 바깥 audit을 쓰며 자기 audit을 받지 않는다(CONFIG).
 *   - audit 없는 audit table write는 CONFIG다. 없는 audit 기록을 가리키는 raw write는 foreign key가
 *     거부한다.
 *   - callback이 실패하면 audit 기록도 rollback된다.
 */
function auditCase(Db $db, string $dsn, string $namespace): void
{
    $itemClass = "$namespace\\Item";
    $outside = auditErrorCode(fn() => (new $itemClass)($db)->setTitle('outside')->create());
    auditWant($outside === Code::CONFIG, "insert without an audit = $outside, want CONFIG");
    foreach ([
        'without an audit source' => new Config(),
        'with a source value that is no column' => new Config(auditSource: static fn(): array => ['reason' => 'x']),
    ] as $name => $config) {
        $other = Orm::connectSchema($dsn, ("$namespace\\schema")(), $config);
        try {
            $code = auditErrorCode(fn() => $other->transaction(fn() => null, audit: ['actor' => 'x']));
        } finally {
            $other->close();
        }
        auditWant($code === Code::CONFIG, "an audit transaction of a connection $name = $code, want CONFIG");
    }
    $unavailable = new RuntimeException('no request');
    $failing = Orm::connectSchema($dsn, ("$namespace\\schema")(), new Config(auditSource: static fn(): array => throw $unavailable));
    try {
        $failing->transaction(fn() => null, audit: []);
        $thrown = null;
    } catch (Throwable $e) {
        $thrown = $e;
    } finally {
        $failing->close();
    }
    auditWant($thrown === $unavailable, 'an audit transaction whose source fails: ' . ($thrown?->getMessage() ?? 'no error') . ', want the source exception');
    $adb = $db;
    $noColumn = auditErrorCode(fn() => $adb->transaction(fn() => null, audit: ['reason' => 'x']));
    auditWant($noColumn === Code::CONFIG, "an audit value that is no column = $noColumn, want CONFIG");

    $seq = $adb->transaction(function () use ($db, $adb, $itemClass): int {
        $seq = (new $itemClass)->setTitle('first')->create()->getSeq();
        $nested = auditErrorCode(fn() => $adb->transaction(fn() => null, audit: ['actor' => 'nested']));
        auditWant($nested === Code::CONFIG, "a nested transaction with an audit = $nested, want CONFIG");
        // 중첩 transaction은 바깥 audit을 쓴다.
        $db->transaction(fn() => (new $itemClass)->setSeq($seq)->setTitle('second')->update(), retry: 0);
        return $seq;
    }, audit: ['actor' => 'create'], retry: 0);
    $third = auditErrorCode(fn() => (new $itemClass)($db)->setSeq($seq)->setTitle('third')->update());
    auditWant($third === Code::CONFIG, "update without an audit = $third, want CONFIG");
    // 값이 없는 audit transaction은 기본값만으로 기록한다.
    $adb->transaction(fn() => (new $itemClass)->setSeq($seq)->delete(), audit: [], retry: 0);
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
