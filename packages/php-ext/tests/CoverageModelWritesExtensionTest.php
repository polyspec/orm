<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

// Arithmetic coverage uses seeded Author.read_count and rolls back the update transaction.
#[Medium]
// Arithmetic coverage uses the seeded Author read_count column; CompositeAccount remains the CRUD fixture.
final class CoverageModelWritesExtensionTest extends TestCase
{
    // Requirements: DSL-104, INT-35, PRT-41.
    public function testCreateParts(): void
    {
        Assert::assertTrue((new ReflectionMethod(Model::class, 'creates'))->isInternal(), 'Model::creates is native');
        require_once dirname(__DIR__, 2) . '/php/tests/CoverageModelWritesCase.php';
        \Polyspec\Orm\Tests\CoverageModelWritesCase::createParts(__FILE__, 990003);
    }

    // Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
    public function testModelWriteCycle(): void
    {
        foreach (['create', 'creates', 'update', 'delete', 'getCount'] as $method) {
            Assert::assertTrue((new ReflectionMethod(Model::class, $method))->isInternal(), "Model::$method is native");
        }
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            try {
                $existing = (new CompositeAccount())($db)->tenantId(990002)->getCount();
                Assert::assertSame(0, $existing, "composite_account holds $existing rows before the case");
                coverageRestoring(function () use ($db): void {
                    $created = (new CompositeAccount())($db)->setTenantId(990002)->setAccountId(1)
                        ->setName('created')->create();
                    Assert::assertSame('created', $created->getName());
                    Assert::assertSame(3, (new CompositeAccount())($db)->creates([
                        (new CompositeAccount())->setTenantId(990002)->setAccountId(2)->setName('many-2'),
                        (new CompositeAccount())->setTenantId(990002)->setAccountId(3)->setName('many-3'),
                        (new CompositeAccount())->setTenantId(990002)->setAccountId(4)->setName('many-4'),
                    ], 2));
                    (new CompositeAccount())($db)->getByTenantIdAndAccountId(990002, 1)
                        ->setName('updated')->update();
                    Assert::assertSame(
                        'updated',
                        (new CompositeAccount())($db)->getByTenantIdAndAccountId(990002, 1)->getName(),
                    );
                    (new CompositeAccount())($db)->setTenantId(990002)->setAccountId(1)->setName('ignored')
                        ->duplication((new CompositeAccount())->setName('upserted'))->create();
                    Assert::assertSame(
                        'upserted',
                        (new CompositeAccount())($db)->getByTenantIdAndAccountId(990002, 1)->getName(),
                    );
                    Assert::assertSame(4, (new CompositeAccount())($db)->tenantId(990002)->getCount());
                    (new CompositeAccount())($db)->tenantId(990002)->gets()->delete();
                    Assert::assertNull((new CompositeAccount())($db)->getByTenantIdAndAccountId(990002, 1));
                    Assert::assertSame(0, (new CompositeAccount())($db)->tenantId(990002)->getCount());
                }, fn() => (new CompositeAccount())($db)->tenantId(990002)->gets()->delete());
            } finally {
                $db->close();
            }
        }
    }

    // Requirements: PLN-26.
    public function testModelWriteArithmeticAttributes(): void
    {
        Assert::assertTrue((new ReflectionMethod(Model::class, 'update'))->isInternal(), 'Model::update is native');
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
                        $unsubscribe = $db->subscribe(static function (\Polyspec\Orm\StatementEvent $event) use (&$events): void {
                            if ($event->kind === \Polyspec\Orm\StatementEvent::UPDATE && in_array('author', $event->tables, true)) {
                                $events[] = $event;
                            }
                        });
                        $loaded = $author()->addAllColumns()->getBySeq(1);
                        $loaded->plusReadCount(7)->update();
                        Assert::assertSame(8, $author()->addAllColumns()->getBySeq(1)->getReadCount(), 'plus updates the non-key column');
                        Assert::assertTrue(array_any($events, static fn($event): bool => in_array(7, $event->binds, true)), 'plus amount is bound');
                        $loaded->update();
                        Assert::assertCount(1, $events, 'a write clears the pending arithmetic change');
                        $current = $author()->addAllColumns()->getBySeq(1);
                        $current->minusReadCount(9)->update();
                        Assert::assertSame(0, $author()->addAllColumns()->getBySeq(1)->getReadCount(), 'minus clamps at zero');
                        Assert::assertTrue(array_any($events, static fn($event): bool => in_array(9, $event->binds, true)), 'minus amount is bound');
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
