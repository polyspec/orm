<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\Request;
use Polyspec\Orm\StyledValue;
use Polyspec\Orm\Tests\Model\Account;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use PHPUnit\Framework\Assert;

final class CoverageModelWritesCase
{
    public static function orderedJsonTextRoundTrip(Db $db): void
    {
        $text = '{"b":1,"a":[],"c":{},"n":1.50}';
        $rollback = new \RuntimeException('rollback ordered JSON text probe');
        try {
            $db->transaction(function () use ($db, $text, $rollback): void {
                $row = (new Author())($db)->addAllColumns()->getBySeq(1);
                Assert::assertNotNull($row, 'seed author row 1 exists');
                $row->setJsonSetting(StyledValue::value(\Polyspec\OrderedJson\parse($text)))->update();

                $stored = (new Author())($db)->addAllColumns()->getBySeq(1);
                Assert::assertNotNull($stored, 'seed author row 1 remains after update');
                Assert::assertSame($text, \Polyspec\OrderedJson\stringify($stored->getJsonSetting()->payload()));
                $cell = $db->pdo()->query('SELECT json_setting FROM author WHERE seq = 1')->fetchColumn();
                Assert::assertSame($text, $cell, 'database stores the ordered JSON text unchanged');
                throw $rollback;
            }, retry: 0);
            Assert::fail('ordered JSON text probe transaction unexpectedly committed');
        } catch (\Throwable $failure) {
            Assert::assertSame($rollback, $failure, 'ordered JSON probe rolls back its row update');
        }
    }

    // DIA-26: a repeated member name is kept in place, with both values, on every database.
    public static function orderedJsonRepeatedMemberNameRoundTrip(Db $db): void
    {
        $text = '{"a":1,"b":2,"a":3}';
        $rollback = new \RuntimeException('rollback repeated member name probe');
        try {
            $db->transaction(function () use ($db, $text, $rollback): void {
                $row = (new Author())($db)->addAllColumns()->getBySeq(1);
                Assert::assertNotNull($row, 'seed author row 1 exists for repeated member names');
                $row->setJsonSetting(StyledValue::value(\Polyspec\OrderedJson\parse($text)))->update();

                $stored = (new Author())($db)->addAllColumns()->getBySeq(1);
                Assert::assertNotNull($stored, 'seed author row 1 remains after repeated member name update');
                Assert::assertSame(
                    $text,
                    $stored->getJsonSetting()->payload()->raw(),
                    'repeated member name text round trip'
                );
                $cell = $db->pdo()->query('SELECT json_setting FROM author WHERE seq = 1')->fetchColumn();
                Assert::assertSame($text, $cell, 'database stores the repeated member name text unchanged');
                throw $rollback;
            }, retry: 0);
            Assert::fail('repeated member name probe transaction unexpectedly committed');
        } catch (\Throwable $failure) {
            Assert::assertSame($rollback, $failure, 'repeated member name probe rolls back its row update');
        }
    }

    public static function codecColumnsRoundTrip(Db $db): void
    {
        $rollback = new \RuntimeException('rollback codec columns probe');
        try {
            $db->transaction(function () use ($db, $rollback): void {
                $row = (new Author())($db)->addAllColumns()->getBySeq(1);
                Assert::assertNotNull($row, 'seed author row 1 exists for codec columns');
                $row->setIp('10.0.0.1')
                    ->setGzExtend(StyledValue::value('compressed text'))
                    ->setBase64Extra(StyledValue::value('plain'))
                    ->update();
                $stored = (new Author())($db)->addAllColumns()->getBySeq(1);
                Assert::assertNotNull($stored, 'author row remains after codec update');
                Assert::assertSame('10.0.0.1', $stored->getIp(), 'ip codec column round trip');
                Assert::assertSame('compressed text', $stored->getGzExtend()->payload(), 'gz codec column round trip');
                Assert::assertSame('plain', $stored->getBase64Extra()->payload(), 'base64 codec column round trip');
                Assert::assertSame(1, (new Author())($db)->ip('10.0.0.1')->getCount(), 'ip codec equality');
                Assert::assertSame(
                    Code::CODEC_ENCODE,
                    coverageCode(static fn() => $stored->setIp('10. 0.0.1')->update()),
                    'ip input with embedded whitespace is rejected',
                );
                $cell = $db->pdo()->query('SELECT base64_extra FROM author WHERE seq = 1')->fetchColumn();
                Assert::assertSame(base64_encode('plain'), $cell, 'database stores the base64 codec output');
                throw $rollback;
            }, retry: 0);
            Assert::fail('codec columns probe transaction unexpectedly committed');
        } catch (\Throwable $failure) {
            $details = [];
            for ($cause = $failure; $cause !== null; $cause = $cause->getPrevious()) {
                $details[] = get_debug_type($cause) . ': ' . $cause->getMessage();
                if ($cause instanceof \Polyspec\Orm\OrmException && $cause->rollback !== null) {
                    $details[] = 'rollback ' . get_debug_type($cause->rollback) . ': '
                        . $cause->rollback->getMessage();
                }
            }
            Assert::assertSame(
                $rollback,
                $failure,
                'codec columns probe rolls back its row update; received ' . implode(' <- ', $details),
            );
        }
    }

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
