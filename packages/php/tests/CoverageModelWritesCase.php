<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use PHPUnit\Framework\Assert;

final class CoverageModelWritesCase
{
    public static function createParts(string $ownerFile, int $tenant): void
    {
        foreach (coverageItemsOf($ownerFile) as $item) {
            selectCoverageItem($item);
            [$driver, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            $account = static fn() => (new CompositeAccount())($db);
            try {
                Assert::assertSame(0, $account()->tenantId($tenant)->getCount(), 'tenant starts empty');
                $events = [];
                $unsubscribe = $db->subscribe(
                    static function (\Polyspec\Orm\StatementEvent $event) use (&$events): void {
                        $events[] = $event;
                    }
                );
                try {
                    $refused = [$account()->setTenantId($tenant)->setAccountId(1)->setName('refused')];
                    Assert::assertSame(Code::CONFIG, coverageCode(static fn() => $account()->creates($refused, 0)));
                    Assert::assertSame([], $events, 'invalid batch sends no statements');
                    $limit = $driver === 'sqlite' ? 999 : 65535;
                    $oversized = array_fill(
                        0,
                        intdiv($limit, 3) + 1,
                        $account()->setTenantId($tenant)->setAccountId(8)->setName('oversized')
                    );
                    Assert::assertSame(
                        Code::BATCH_TOO_LARGE,
                        coverageCode(static fn() => $account()->creates($oversized, count($oversized))),
                        'over-limit batch is refused',
                    );
                    Assert::assertSame([], $events, 'over-limit batch sends no statements');

                    $labels = ['ordered-5', 'ordered-4', 'ordered-3', 'ordered-2', 'ordered-1'];
                    $rows = [];
                    foreach ($labels as $i => $label) {
                        $rows[] = (new CompositeAccount())->setTenantId($tenant)
                            ->setAccountId($i + 1)
                            ->setName($label);
                    }
                    Assert::assertSame(5, $account()->creates($rows, 2), 'creates inserts all rows');
                    $inserts = array_values(
                        array_filter($events, static fn($event): bool => $event->kind === 'insert')
                    );
                    $sizes = array_map(static fn($event): int => intdiv(count($event->binds), 3), $inserts);
                    Assert::assertSame([2, 2, 1], $sizes, 'INSERT batches are 2, 2, 1');
                    $stored = $account()->tenantId($tenant)->orderByAccountIdAsc()->gets()->all();
                    $storedLabels = array_map(static fn(CompositeAccount $row): string => $row->getName(), $stored);
                    Assert::assertSame($labels, $storedLabels, 'stored rows preserve input order');

                    $account()->tenantId($tenant)->gets()->delete();
                    $events = [];
                    $account()->setTenantId($tenant)->setAccountId(99)->setName('existing')->create();
                    $events = [];
                    $failing = [];
                    foreach ([10, 11, 12, 13, 99] as $id) {
                        $failing[] = (new CompositeAccount())->setTenantId($tenant)
                            ->setAccountId($id)
                            ->setName("rollback-$id");
                    }
                    Assert::assertSame(
                        Code::DUPLICATE_KEY,
                        coverageCode(static fn() => $account()->creates($failing, 2)),
                    );
                    $failedInserts = array_values(
                        array_filter($events, static fn($event): bool => $event->kind === 'insert')
                    );
                    $failedSizes = array_map(static fn($event): int => intdiv(count($event->binds), 3), $failedInserts);
                    Assert::assertSame([2, 2, 1], $failedSizes, 'failure is in the third batch');
                    $remaining = $account()->tenantId($tenant)->getCount();
                    Assert::assertSame(1, $remaining, 'failed call rolls back earlier batches');
                    Assert::assertSame('existing', $account()->getByTenantIdAndAccountId($tenant, 99)?->getName());
                } finally {
                    $unsubscribe();
                }
                $account()->tenantId($tenant)->gets()->delete();
                Assert::assertSame(0, $account()->tenantId($tenant)->getCount(), 'case leaves no rows');
            } finally {
                try {
                    $account()->tenantId($tenant)->gets()->delete();
                } finally {
                    $db->close();
                }
            }
        }
    }

    /** PLN-26: plus and minus update the non-key column as bound amounts, minus clamps at zero, and a rollback restores it. */
    public static function arithmeticAttributes(string $ownerFile): void
    {
        foreach (coverageItemsOf($ownerFile) as $item) {
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
