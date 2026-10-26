<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// transactions feature coverage: an error from a transaction callback reaches the caller,
// rolls back the rows written, and a failure in a nested transaction reverts only the savepoint.
// Writes only rows of composite_account for tenant 990003, and removes them all.


use Closure;
use RuntimeException;
use Polyspec\Orm\Code;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Db;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const TRANSACTION_TENANT = 990003;

/** Runs $body when no row of tenant 990003 exists, and removes that tenant's rows at the end. */
function transactionCase(Closure $body): void
{
    [, $dsn] = coverageItem();
    $db = coverageConnect($dsn);
    try {
        $existing = (new CompositeAccount())($db)->tenantId(TRANSACTION_TENANT)->getCount();
        Assert::assertTrue(
            $existing === 0,
            "composite_account holds $existing rows of tenant " . TRANSACTION_TENANT . ' before the case'
        );
        coverageRestoring(
            fn() => $body($db),
            fn() => (new CompositeAccount())($db)->tenantId(TRANSACTION_TENANT)->gets()->delete()
        );
    } finally {
        $db->close();
    }
}

function accountExists(Db $db, int $accountId): bool
{
    return (new CompositeAccount())($db)->tenantId(TRANSACTION_TENANT)->andAccountId($accountId)->getCount() === 1;
}

#[Medium]
class CoverageTransactionsTest extends TestCase
{
    // Requirements: DSL-118, INT-45, INT-67, PLN-13, PLN-16, PLN-20, PLN-44.
    public function testTransactionRollback(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            transactionCase(function (Db $db): void {
                Assert::assertSame(
                    Code::CONFIG,
                    coverageCode(fn() => (new CompositeAccount())->getCount()),
                    'an unconnected model outside a transaction returns CONFIG'
                );
                $boom = new RuntimeException('rollback requested');
                $caught = null;
                try {
                    $db->transaction(function () use ($boom): void {
                        (new CompositeAccount())->setTenantId(TRANSACTION_TENANT)
                            ->setAccountId(1)
                            ->setName('rolled')
                            ->create();
                        throw $boom;
                    }, retry: 0);
                } catch (RuntimeException $e) {
                    $caught = $e;
                }
                Assert::assertTrue(
                    $caught === $boom,
                    'the callback error did not reach the caller: ' . ($caught?->getMessage() ?? 'no error')
                );
                Assert::assertTrue(!accountExists($db, 1), 'the rolled back row exists');
            });
        }
    }

    // Requirements: DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43.
    // Requirements: INT-45, INT-46, INT-47, INT-48, PLN-17, PLN-21, PLN-24, PLN-44.
    public function testTransactionSavepoint(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            transactionCase(function (Db $db) use ($item): void {
                $boom = new RuntimeException('inner failure');
                $inner = null;
                $db->transaction(function () use ($db, $boom, &$inner): void {
                    (new CompositeAccount())->setTenantId(TRANSACTION_TENANT)
                        ->setAccountId(2)
                        ->setName('outer')
                        ->create();
                    foreach (['forUpdate', 'forShare', 'forUpdateNoWait', 'forShareNoWait'] as $lock) {
                        $row = (new CompositeAccount())($db)->tenantId(TRANSACTION_TENANT)
                            ->andAccountId(2)->{$lock}()->get();
                        Assert::assertNotNull($row, "$lock works inside a transaction");
                    }
                    foreach ([['isolation' => 'serializable'], ['readOnly' => true], ['timeoutMs' => 1]] as $options) {
                        $called = false;
                        Assert::assertSame(
                            Code::CONFIG,
                            coverageCode(fn() => $db->transaction(function () use (&$called): void {
                                $called = true;
                            }, ...$options)),
                            'a nested transaction rejects every option except retry',
                        );
                        Assert::assertFalse($called, 'an invalid nested option does not run its callback');
                    }
                    try {
                        $innerCalls = 0;
                        $db->transaction(function () use ($boom, &$innerCalls): void {
                            $innerCalls++;
                            (new CompositeAccount())->setTenantId(TRANSACTION_TENANT)
                                ->setAccountId(3)
                                ->setName('inner')
                                ->create();
                            throw $boom;
                        }, retry: 3);
                    } catch (RuntimeException $e) {
                        $inner = $e;
                    }
                    Assert::assertSame(1, $innerCalls, 'nested retry is accepted and ignored');
                }, isolation: 'read_committed', retry: 0);
                Assert::assertTrue($inner === $boom, 'the nested transaction error did not reach the outer callback');
                Assert::assertTrue(accountExists($db, 2), 'the outer row was not committed');
                Assert::assertTrue(!accountExists($db, 3), 'the savepoint row exists');
                foreach (['forUpdate', 'forShare', 'forUpdateNoWait', 'forShareNoWait'] as $lock) {
                    Assert::assertSame(
                        Code::CONFIG,
                        coverageCode(fn() => (new CompositeAccount())($db)->tenantId(TRANSACTION_TENANT)
                            ->andAccountId(2)->{$lock}()->get()),
                        "$lock outside a transaction returns CONFIG"
                    );
                }
                (new CompositeAccount())($db)->getByTenantIdAndAccountId(TRANSACTION_TENANT, 2)->delete();
                Assert::assertTrue(!accountExists($db, 2), 'the outer row was not deleted');

                $flowError = FiberTransaction::outsideError(FiberTransaction::holding($db), $db);
                Assert::assertNull(
                    $db->transactionNumber(),
                    'a completed Fiber leaves no active transaction frame'
                );
                Assert::assertSame(
                    Code::CONFIG,
                    $flowError?->code_,
                    'a second Fiber cannot use an active transaction connection',
                );

                foreach (['read_uncommitted', 'read_committed', 'repeatable_read', 'serializable'] as $isolation) {
                    $db->transaction(static fn() => null, isolation: $isolation, retry: 0);
                }

                $readOnlyError = null;
                try {
                    $db->transaction(function () use ($db): void {
                        (new CompositeAccount())->setTenantId(TRANSACTION_TENANT)
                            ->setAccountId(4)->setName('read only')->create();
                    }, readOnly: true, retry: 0);
                } catch (OrmException $error) {
                    $readOnlyError = $error;
                }
                Assert::assertSame(Code::READ_ONLY, $readOnlyError?->code_, 'read-only write error');
                Assert::assertFalse(accountExists($db, 4), 'read-only transaction wrote a row');

                $timeoutError = null;
                $timeoutCalls = 0;
                try {
                    $db->transaction(static function () use (&$timeoutCalls): void {
                        $timeoutCalls++;
                    }, timeoutMs: 500, retry: 0);
                } catch (OrmException $error) {
                    $timeoutError = $error;
                }
                if ($item[0] === 'postgres') {
                    Assert::assertNull($timeoutError, 'PostgreSQL supports transaction timeoutMs');
                    Assert::assertSame(1, $timeoutCalls, 'PostgreSQL timeout callback ran');
                } else {
                    Assert::assertSame(
                        Code::CAPABILITY_UNSUPPORTED,
                        $timeoutError?->code_,
                        'timeoutMs unsupported driver',
                    );
                    Assert::assertSame(0, $timeoutCalls, 'unsupported timeout fails before the callback');
                }

                if ($item[0] === 'postgres') {
                    (new CompositeAccount())($db)->setTenantId(TRANSACTION_TENANT)
                        ->setAccountId(6)->setName('before timeout')->create();
                    $holder = coverageConnect((string) $item[1]);
                    try {
                        $fiber = new \Fiber(function () use ($holder): void {
                            $holder->transaction(function () use ($holder): void {
                                (new CompositeAccount())($holder)->tenantId(TRANSACTION_TENANT)->forUpdate()->get();
                                \Fiber::suspend('row lock acquired');
                            }, retry: 0);
                        });
                        Assert::assertSame('row lock acquired', $fiber->start(), 'the holder has the row lock');
                        $timeoutError = null;
                        try {
                            $db->transaction(function () use ($db): void {
                                $row = (new CompositeAccount())($db)
                                    ->getByTenantIdAndAccountId(TRANSACTION_TENANT, 6);
                                $row->setName('timed out')->update();
                            }, timeoutMs: 250, retry: 0);
                        } catch (OrmException $error) {
                            $timeoutError = $error;
                        } finally {
                            $fiber->resume();
                        }
                        Assert::assertSame(
                            Code::CANCELED,
                            $timeoutError?->code_,
                            'locked statement exceeds transaction timeoutMs: '
                                . ($timeoutError?->getMessage() ?? 'no error')
                        );
                        Assert::assertSame(
                            'before timeout',
                            (new CompositeAccount())($db)->getByTenantIdAndAccountId(TRANSACTION_TENANT, 6)->getName(),
                            'timed out update rolled back'
                        );
                        (new CompositeAccount())($db)->getByTenantIdAndAccountId(TRANSACTION_TENANT, 6)->delete();
                    } finally {
                        $holder->close();
                    }
                }

                $attempts = 0;
                $db->transaction(function () use (&$attempts): void {
                    $attempts++;
                    (new CompositeAccount())->setTenantId(TRANSACTION_TENANT)
                        ->setAccountId(5)->setName('attempt-' . $attempts)->create();
                    if ($attempts < 3) {
                        throw Orm::transactionConflict('coverage retry');
                    }
                }, isolation: 'read_committed', retry: 3);
                Assert::assertSame(3, $attempts, 'retry reruns the complete callback');
                Assert::assertSame(
                    'attempt-3',
                    (new CompositeAccount())($db)->getByTenantIdAndAccountId(TRANSACTION_TENANT, 5)->getName(),
                    'the final callback attempt committed'
                );
                (new CompositeAccount())($db)->getByTenantIdAndAccountId(TRANSACTION_TENANT, 5)->delete();

                $defaultAttempts = 0;
                $db->transaction(function () use (&$defaultAttempts): void {
                    $defaultAttempts++;
                    if ($defaultAttempts < 3) {
                        throw Orm::transactionConflict('default coverage retry');
                    }
                });
                Assert::assertSame(3, $defaultAttempts, 'default retry count is three');

                $attempts = 0;
                $retryError = null;
                try {
                    $db->transaction(function () use (&$attempts): void {
                        $attempts++;
                        throw Orm::transactionConflict('coverage retry disabled');
                    }, retry: 0);
                } catch (OrmException $error) {
                    $retryError = $error;
                }
                Assert::assertSame(Code::DEADLOCK, $retryError?->code_, 'retry=0 returns the deadlock');
                Assert::assertSame(1, $attempts, 'retry=0 invokes the callback once');
            });
        }
    }
}
