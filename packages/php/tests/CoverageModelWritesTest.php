<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// model_writes feature coverage uses CompositeAccount for CRUD and seeded Author.read_count for arithmetic.
// The arithmetic case rolls back its updates to preserve the seeded row and identity sequence.


use Polyspec\Orm\Request;
use Polyspec\Orm\Tests\Model\Account;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const WRITE_TENANT = 990002;

#[Medium]
final class CoverageModelWritesTest extends TestCase
{
    // Requirements: DSL-109.
    public function testSaveKeyDispatch(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            $writes = [];
            $sentinel = new RuntimeException('DSL-109 request hook stopped the write');
            $hooked = $db->withRequestHook(static function (Request $request) use (&$writes, $sentinel): void {
                $kind = $request->ir['kind'];
                if (in_array($kind, ['insert', 'update'], true)) {
                    $writes[] = $kind;
                    throw $sentinel;
                }
            });
            try {
                $rejectWrite = static function (Closure $save) use ($sentinel): void {
                    try {
                        $save();
                    } catch (Throwable $failure) {
                        Assert::assertSame($sentinel, $failure, 'Save propagates the request-hook sentinel');
                        return;
                    }
                    Assert::fail('Save reached execution instead of the request hook');
                };
                $account = static fn() => (new Account())($hooked);
                $rejectWrite(static fn() => $account()->setName('missing')->save());
                Assert::assertSame(['insert'], $writes, 'missing key Save selects INSERT');

                $writes = [];
                $rejectWrite(static fn() => $account()->setSeq(0)->setName('zero')->save());
                Assert::assertSame(['update'], $writes, 'explicit zero Save selects UPDATE');

                $writes = [];
                $loaded = (new Author())($hooked)->addAllColumns()->getBySeq(1);
                Assert::assertNotNull($loaded, 'seeded author row loads through the hooked handle');
                $rejectWrite(static fn() => $loaded->setReadCount($loaded->getReadCount())->save());
                Assert::assertSame(['update'], $writes, 'loaded original key Save selects UPDATE');
            } finally {
                $db->close();
            }
        }
    }

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
        require_once __DIR__ . '/CoverageModelWritesCase.php';
        CoverageModelWritesCase::arithmeticAttributes(__FILE__);
    }
}
