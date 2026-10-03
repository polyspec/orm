<?php
declare(strict_types=1);
// 실행 중인 transaction에서 operation id를 정하는 scenario(clients/go/orm/audit_operation_test.go의
// setOperationCase와 같다). runtime_db_test.php의 owner case와 coverage_audit_triggers.php의
// audit_operation_set_in_transaction case가 함께 쓴다. 호출자는 contracts/fixtures/audit.dbs의 model을
// $namespace에 생성하고 연결에 설치한다.

use Orm\Code;
use Orm\Db;
use Orm\OrmException;

/** $fn이 던진 OrmException의 code다. 성공하면 'no error'다. */
function setOperationCode(Closure $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

function setOperationWant(bool $ok, string $message): void
{
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

/**
 * utils()->setOperation($id)는 transaction이 시작한 뒤 operation id를 정한다. transaction 밖에서는 CONFIG,
 * 정하기 전의 audit 대상 write는 CONFIG다. 같은 id를 다시 정하면 아무것도 바꾸지 않고, 다른 id는 중첩
 * transaction에서도, transaction option으로 정한 id에 대해서도 CONFIG다. rollback한 savepoint는 그 안에서
 * 정한 id를 되돌린다. item_history는 각 version을 그 operation id로 기록한다.
 */
function setOperationCase(Db $db, string $namespace): void
{
    $itemClass = "$namespace\\Item";
    $code = setOperationCode(fn() => $db->utils()->setOperation(1));
    setOperationWant($code === Code::CONFIG, "setOperation outside a transaction = $code, want CONFIG");

    $seq = $db->transaction(function () use ($db, $itemClass): int {
        $before = setOperationCode(fn() => (new $itemClass)->setTitle('before')->create());
        setOperationWant($before === Code::CONFIG, "an audited insert before setOperation = $before, want CONFIG");
        $db->utils()->setOperation(7);
        $seq = (new $itemClass)->setTitle('first')->create()->getSeq();
        $db->utils()->setOperation(7);
        $other = setOperationCode(fn() => $db->utils()->setOperation(8));
        setOperationWant($other === Code::CONFIG, "another operation id = $other, want CONFIG");
        $db->transaction(function () use ($db, $itemClass, $seq): void {
            $nested = setOperationCode(fn() => $db->utils()->setOperation(9));
            setOperationWant($nested === Code::CONFIG, "another operation id in a nested transaction = $nested, want CONFIG");
            (new $itemClass)->setSeq($seq)->setTitle('second')->update();
        }, retry: 0);
        return $seq;
    }, retry: 0);

    $db->transaction(function () use ($db, $itemClass, $seq): void {
        $rolledBack = new RuntimeException('savepoint rolled back');
        try {
            $db->transaction(function () use ($db, $rolledBack): void {
                $db->utils()->setOperation(10);
                throw $rolledBack;
            }, retry: 0);
            throw new RuntimeException('the nested transaction did not fail');
        } catch (RuntimeException $e) {
            if ($e !== $rolledBack) {
                throw $e;
            }
        }
        $after = setOperationCode(fn() => (new $itemClass)->setSeq($seq)->setTitle('third')->update());
        setOperationWant($after === Code::CONFIG, "an audited update after the savepoint that set the id rolled back = $after, want CONFIG");
        $db->utils()->setOperation(11);
        (new $itemClass)->setSeq($seq)->setTitle('third')->update();
    }, retry: 0);

    $db->transaction(function () use ($db, $itemClass, $seq): void {
        $db->utils()->setOperation(12);
        $other = setOperationCode(fn() => $db->utils()->setOperation(13));
        setOperationWant($other === Code::CONFIG, "another id than the option's = $other, want CONFIG");
        (new $itemClass)->setSeq($seq)->delete();
    }, retry: 0, operation: 12);

    $change = $db->driver() === 'mysql' ? '`change`' : '"change"';
    $rows = $db->pdo()->query("SELECT $change, previous_operation_id, seq, title, operation_id, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM item_history ORDER BY history_id")->fetchAll(PDO::FETCH_NUM);
    $history = array_map(static fn(array $r): array => array_map(static fn(mixed $v): string => $v === null ? 'NULL' : (string) $v, $r), $rows);
    $s = (string) $seq;
    $want = [
        ['insert', 'NULL', $s, 'first', '7', 'live'],
        ['update', '7', $s, 'second', '7', 'live'],
        ['update', '7', $s, 'third', '11', 'live'],
        ['update', '11', $s, 'third', '12', 'deleted'],
    ];
    setOperationWant($history === $want, 'item_history ' . json_encode($history) . ', want ' . json_encode($want));
}
