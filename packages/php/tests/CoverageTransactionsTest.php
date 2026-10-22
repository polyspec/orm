<?php

declare(strict_types=1);

// transactions feature coverage: an error from a transaction callback reaches the caller,
// rolls back the rows written, and a failure in a nested transaction reverts only the savepoint.
// Writes only rows of composite_account for tenant 990003, and removes them all.


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
final class CoverageTransactionsTest extends TestCase
{
    // Requirements: DSL-118, INT-45, PLN-13, PLN-20.
    public function testTransactionRollback(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            transactionCase(function (Db $db): void {
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

    // Requirements: DSL-119, INT-45, INT-46, PLN-17.
    public function testTransactionSavepoint(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            transactionCase(function (Db $db): void {
                $boom = new RuntimeException('inner failure');
                $inner = null;
                $db->transaction(function () use ($db, $boom, &$inner): void {
                    (new CompositeAccount())->setTenantId(TRANSACTION_TENANT)
                        ->setAccountId(2)
                        ->setName('outer')
                        ->create();
                    try {
                        $db->transaction(function () use ($boom): void {
                            (new CompositeAccount())->setTenantId(TRANSACTION_TENANT)
                                ->setAccountId(3)
                                ->setName('inner')
                                ->create();
                            throw $boom;
                        });
                    } catch (RuntimeException $e) {
                        $inner = $e;
                    }
                }, retry: 0);
                Assert::assertTrue($inner === $boom, 'the nested transaction error did not reach the outer callback');
                Assert::assertTrue(accountExists($db, 2), 'the outer row was not committed');
                Assert::assertTrue(!accountExists($db, 3), 'the savepoint row exists');
                (new CompositeAccount())($db)->getByTenantIdAndAccountId(TRANSACTION_TENANT, 2)->delete();
                Assert::assertTrue(!accountExists($db, 2), 'the outer row was not deleted');
            });
        }
    }
}
