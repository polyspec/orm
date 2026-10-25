<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// model_writes feature coverage: the create of the generated CompositeAccount model,
// update, duplication (upsert), count, and delete, on rows of tenant 990002,
// and removes all those rows. composite_account has no identity column, so
// the database state is left the same as before the run.


use Polyspec\Orm\Tests\Model\CompositeAccount;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const WRITE_TENANT = 990002;

#[Medium]
final class CoverageModelWritesTest extends TestCase
{
    // Requirements: DSL-104, INT-35, PRT-41.
    public function testCreateParts(): void
    {
        require_once __DIR__ . '/CoverageModelWritesCase.php';
        CoverageModelWritesCase::createParts(__FILE__, WRITE_TENANT + 1);
    }

    // Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
    public function testModelWriteCycle(): void
    {
        coverageAssertEntryClassesAreInternal();
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $existing = (new CompositeAccount())($db)->tenantId(WRITE_TENANT)->getCount();
                Assert::assertTrue(
                    $existing === 0,
                    "composite_account holds $existing rows of tenant " . WRITE_TENANT . ' before the case'
                );
                coverageRestoring(function () use ($db): void {
                    $created = (new CompositeAccount())($db)->setTenantId(WRITE_TENANT)
                        ->setAccountId(1)
                        ->setName('created')
                        ->create();
                    Assert::assertTrue(
                        $created->getName() === 'created' && $created->getAccountId() === 1,
                        'created row ' . json_encode($created->toArray())
                    );
                    $inserted = (new CompositeAccount())($db)->creates([
                        (new CompositeAccount())->setTenantId(WRITE_TENANT)->setAccountId(2)->setName('many-2'),
                        (new CompositeAccount())->setTenantId(WRITE_TENANT)->setAccountId(3)->setName('many-3'),
                        (new CompositeAccount())->setTenantId(WRITE_TENANT)->setAccountId(4)->setName('many-4'),
                    ], 2);
                    Assert::assertTrue($inserted === 3, "creates inserted $inserted rows, want 3");
                    (new CompositeAccount())($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)
                        ->setName('updated')
                        ->update();
                    $name = (new CompositeAccount())($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)->getName();
                    Assert::assertTrue($name === 'updated', "updated name is $name");
                    (new CompositeAccount())($db)->setTenantId(WRITE_TENANT)->setAccountId(1)->setName('ignored')
                        ->duplication((new CompositeAccount())->setName('upserted'))->create();
                    $name = (new CompositeAccount())($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1)->getName();
                    Assert::assertTrue($name === 'upserted', "upserted name is $name");
                    $count = (new CompositeAccount())($db)->tenantId(WRITE_TENANT)->getCount();
                    Assert::assertTrue($count === 4, "tenant row count is $count, want 4");
                    (new CompositeAccount())($db)->tenantId(WRITE_TENANT)->gets()->delete();
                    $missing = (new CompositeAccount())($db)->getByTenantIdAndAccountId(WRITE_TENANT, 1);
                    Assert::assertNull($missing, 'get of a deleted row is not null');
                    $left = (new CompositeAccount())($db)->tenantId(WRITE_TENANT)->getCount();
                    Assert::assertTrue($left === 0, "$left rows left after delete");
                }, fn() => (new CompositeAccount())($db)->tenantId(WRITE_TENANT)->gets()->delete());
            } finally {
                $db->close();
            }
        }
    }

    // Requirements: PLN-26.
    public function testModelWriteArithmeticAttributes(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            $account = static function () use ($db): CompositeAccount {
                return (new CompositeAccount())($db);
            };
            $tenant = 1_000_000_000_000 + getmypid();
            try {
                Assert::assertSame(0, $account()->tenantId($tenant)->getCount(), 'scratch tenant starts empty');
                $account()->setTenantId($tenant)->setAccountId(1)->setName('arithmetic')->create();
                $loaded = $account()->getByTenantIdAndAccountId($tenant, 1);
                Assert::assertNotNull($loaded, 'created row is readable');
                $events = [];
                $unsubscribe = $db->subscribe(static function (\Polyspec\Orm\StatementEvent $event) use (&$events): void {
                    if ($event->kind === \Polyspec\Orm\StatementEvent::UPDATE && in_array('composite_account', $event->tables, true)) {
                        $events[] = $event;
                    }
                });
                try {
                    coverageRestoring(function () use ($account, $loaded, &$events, $tenant): void {
                        $loaded->plusAccountId(7)->update();
                        Assert::assertSame('arithmetic', $account()->getByTenantIdAndAccountId($tenant, 8)->getName(), 'plus amount changes the key');
                        $plusBound = false;
                        foreach ($events as $event) {
                            $plusBound = $plusBound || in_array(7, $event->binds, true);
                        }
                        Assert::assertTrue($plusBound, 'plus amount is bound');
                        $loaded->update();
                        Assert::assertCount(1, $events, 'a write clears the pending arithmetic change');

                        $current = $account()->getByTenantIdAndAccountId($tenant, 8);
                        $amount = $current->getAccountId() + 1;
                        $current->minusAccountId($amount)->update();
                        Assert::assertSame('arithmetic', $account()->getByTenantIdAndAccountId($tenant, 0)->getName(), 'minus clamps at zero');
                        $minusBound = false;
                        foreach ($events as $event) {
                            $minusBound = $minusBound || in_array($amount, $event->binds, true);
                        }
                        Assert::assertTrue($minusBound, 'minus amount is bound');
                    }, static function () use ($account, $tenant): void {
                        $account()->tenantId($tenant)->gets()->delete();
                    });
                } finally {
                    $unsubscribe();
                }
                Assert::assertSame(0, $account()->tenantId($tenant)->getCount(), 'scratch row is removed');
            } finally {
                try {
                    $account()->tenantId($tenant)->gets()->delete();
                } finally {
                    $db->close();
                }
            }
        }
    }
}
