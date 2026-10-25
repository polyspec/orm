<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// model_writes feature coverage uses CompositeAccount for CRUD and seeded Author.read_count for arithmetic.
// The arithmetic case rolls back its updates to preserve the seeded row and identity sequence.


use Polyspec\Orm\Tests\Model\Author;
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
            $author = static fn() => (new Author())($db);
            $unsubscribe = null;
            try {
                $before = $author()->addAllColumns()->getBySeq(1);
                Assert::assertNotNull($before, 'seed author 1 exists');
                $beforeReadCount = $before->getReadCount();
                $beforeUpdatedTs = $before->getUpdatedTs();
                Assert::assertSame(1, $beforeReadCount, 'seed author 1 read_count');
                $boom = new \RuntimeException('PLN-26 rollback sentinel');
                $events = [];
                $caught = null;
                try {
                    $db->transaction(function () use ($author, $db, &$events, &$unsubscribe, $boom): void {
                        $loaded = $author()->addAllColumns()->getBySeq(1);
                        Assert::assertNotNull($loaded, 'seed author 1 is readable in the transaction');
                        $loaded->setReadCount(1)->update();
                        $unsubscribe = $db->subscribe(static function (
                            \Polyspec\Orm\StatementEvent $event,
                        ) use (&$events): void {
                            if (
                                $event->kind === \Polyspec\Orm\StatementEvent::UPDATE && in_array(
                                    'author',
                                    $event->tables,
                                    true,
                                )
                            ) {
                                $events[] = $event;
                            }
                        });
                        $loaded = $author()->addAllColumns()->getBySeq(1);
                        $loaded->plusReadCount(7)->update();
                        Assert::assertSame(
                            8,
                            $author()->addAllColumns()->getBySeq(1)->getReadCount(),
                            'plus updates the non-key column',
                        );
                        Assert::assertTrue(
                            array_any($events, static fn($event): bool => in_array(7, $event->binds, true)),
                            'plus amount is bound',
                        );
                        $loaded->update();
                        Assert::assertCount(1, $events, 'a write clears the pending arithmetic change');
                        $current = $author()->addAllColumns()->getBySeq(1);
                        $current->minusReadCount(9)->update();
                        Assert::assertSame(
                            0,
                            $author()->addAllColumns()->getBySeq(1)->getReadCount(),
                            'minus clamps at zero',
                        );
                        Assert::assertTrue(
                            array_any($events, static fn($event): bool => in_array(9, $event->binds, true)),
                            'minus amount is bound',
                        );
                        throw $boom;
                    }, retry: 0);
                } catch (\Throwable $error) {
                    $caught = $error;
                }
                Assert::assertSame($boom, $caught, 'transaction returns the rollback sentinel');
                $after = $author()->addAllColumns()->getBySeq(1);
                Assert::assertSame($beforeReadCount, $after->getReadCount(), 'rollback restores read_count');
                Assert::assertEquals($beforeUpdatedTs, $after->getUpdatedTs(), 'rollback restores updated_ts');
            } finally {
                try {
                    if ($unsubscribe !== null) {
                        $unsubscribe();
                    }
                } finally {
                    $db->close();
                }
            }
        }
    }
}
