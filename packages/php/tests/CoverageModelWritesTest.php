<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// model_writes feature coverage: the create of the generated CompositeAccount model,
// update, duplication (upsert), count, and delete, on rows of tenant 990002,
// and removes all those rows. composite_account has no identity column, so
// the database state is left the same as before the run.


use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Code;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const WRITE_TENANT = 990002;

#[Medium]
final class CoverageModelWritesTest extends TestCase
{
    /**
     * With the extension loaded (php-extension, S10) the client's entry classes are the extension's: a fallback to the
     * PHP classes would not test the extension, so each one is asserted internal.
     */
    private static function assertEntryClassesAreInternal(): void
    {
        if (getenv('ORM_PHP_MODE') !== 'extension') {
            return;
        }
        foreach (['Polyspec\\Orm\\Db', 'Polyspec\\Orm\\Planner'] as $entry) {
            Assert::assertTrue((new \ReflectionClass($entry))->isInternal(), "$entry is the extension class");
        }
    }

    // Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
    public function testModelWriteCycle(): void
    {
        self::assertEntryClassesAreInternal();
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
}
