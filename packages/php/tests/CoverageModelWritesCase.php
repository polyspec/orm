<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Code;
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
}
