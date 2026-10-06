<?php
declare(strict_types=1);
// transactions feature coverage: transaction callback의 오류는 호출자에게
// 전달되고 쓴 행을 rollback하며, 중첩 transaction의 실패는 savepoint만
// 되돌린다. tenant 990003의 composite_account 행만 쓰고 모두 지운다.

require __DIR__ . '/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Db;

const TRANSACTION_TENANT = 990003;

/** tenant 990003의 행이 없을 때 $body를 실행하고, 끝나면 그 tenant의 행을 지운다. */
function transactionCase(Closure $body): void
{
    [, $dsn] = coverageDatabase();
    $db = coverageConnect($dsn);
    try {
        $existing = (new CompositeAccount)($db)->tenantId(TRANSACTION_TENANT)->getCount();
        coverageWant($existing === 0, "composite_account holds $existing rows of tenant " . TRANSACTION_TENANT . ' before the case');
        coverageRestoring(fn() => $body($db), fn() => (new CompositeAccount)($db)->tenantId(TRANSACTION_TENANT)->gets()->delete());
    } finally {
        $db->close();
    }
}

function accountExists(Db $db, int $accountId): bool
{
    return (new CompositeAccount)($db)->tenantId(TRANSACTION_TENANT)->andAccountId($accountId)->getCount() === 1;
}

runCoverageCases($argv, [
    'transaction_rollback' => fn() => transactionCase(function (Db $db): void {
        $boom = new RuntimeException('rollback requested');
        $caught = null;
        try {
            $db->transaction(function () use ($boom): void {
                (new CompositeAccount)->setTenantId(TRANSACTION_TENANT)->setAccountId(1)->setName('rolled')->create();
                throw $boom;
            }, retry: 0);
        } catch (RuntimeException $e) {
            $caught = $e;
        }
        coverageWant($caught === $boom, 'the callback error did not reach the caller: ' . ($caught?->getMessage() ?? 'no error'));
        coverageWant(!accountExists($db, 1), 'the rolled back row exists');
    }),
    'transaction_savepoint' => fn() => transactionCase(function (Db $db): void {
        $boom = new RuntimeException('inner failure');
        $inner = null;
        $db->transaction(function () use ($db, $boom, &$inner): void {
            (new CompositeAccount)->setTenantId(TRANSACTION_TENANT)->setAccountId(2)->setName('outer')->create();
            try {
                $db->transaction(function () use ($boom): void {
                    (new CompositeAccount)->setTenantId(TRANSACTION_TENANT)->setAccountId(3)->setName('inner')->create();
                    throw $boom;
                });
            } catch (RuntimeException $e) {
                $inner = $e;
            }
        }, retry: 0);
        coverageWant($inner === $boom, 'the nested transaction error did not reach the outer callback');
        coverageWant(accountExists($db, 2), 'the outer row was not committed');
        coverageWant(!accountExists($db, 3), 'the savepoint row exists');
        (new CompositeAccount)($db)->getByTenantIdAndAccountId(TRANSACTION_TENANT, 2)->delete();
        coverageWant(!accountExists($db, 2), 'the outer row was not deleted');
    }),
]);
