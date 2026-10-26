<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Collection;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\Author;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\Tests\Model\ServiceMember;
use Polyspec\Orm\Tests\Model\ServiceRegion;
use Polyspec\Orm\Tests\Model\User;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;

#[Small]
final class ModelQueriesWritesNativeTest extends TestCase
{
    public function testNativeModelQueryBuildsAndAssemblesACollection(): void
    {
        self::assertTrue((new ReflectionClass(Model::class))->isInternal());
        self::assertTrue((new ReflectionMethod(Model::class, 'gets'))->isInternal());
        self::assertTrue((new ReflectionClass(Collection::class))->isInternal());

        $path = tempnam(sys_get_temp_dir(), 'orm-model-query-native-');
        self::assertNotFalse($path);
        $db = \Polyspec\Orm\Tests\Model\connect('sqlite://' . $path, new Config());
        try {
            \Polyspec\Orm\Tests\installBench($db);
            foreach ([['first', 1], ['second', 2], ['third', 3]] as [$name, $account]) {
                (new CompositeAccount())->connect($db)
                    ->setTenantId(734001)
                    ->setAccountId($account)
                    ->setName($name)
                    ->create();
            }

            $rows = (new CompositeAccount())->connect($db)
                ->tenantId(734001)
                ->orderByAccountIdDesc()
                ->limit(1, 1)
                ->gets();

            self::assertInstanceOf(Collection::class, $rows);
            self::assertSame([['tenantId' => 734001, 'accountId' => 2, 'name' => 'second']], array_map(
                static fn(CompositeAccount $row): array => [
                    'tenantId' => $row->getTenantId(),
                    'accountId' => $row->getAccountId(),
                    'name' => $row->getName(),
                ],
                $rows->all(),
            ));
        } finally {
            $db->close();
            unlink($path);
        }
    }

    // Requirements: DSL-58, DSL-60, DSL-105, DSL-110.
    public function testNativeModelWritesRoundTripThroughSqliteMemory(): void
    {
        self::assertTrue((new ReflectionMethod(Model::class, 'create'))->isInternal());
        self::assertTrue((new ReflectionMethod(Model::class, 'update'))->isInternal());
        self::assertTrue((new ReflectionMethod(Model::class, 'delete'))->isInternal());

        $path = tempnam(sys_get_temp_dir(), 'orm-model-write-native-');
        self::assertNotFalse($path);
        $db = \Polyspec\Orm\Tests\Model\connect('sqlite://' . $path, new Config());
        try {
            \Polyspec\Orm\Tests\installBench($db);
            (new CompositeAccount())->connect($db)
                ->setTenantId(734002)
                ->setAccountId(1)
                ->setName('created')
                ->create();

            (new CompositeAccount())->connect($db)
                ->getByTenantIdAndAccountId(734002, 1)
                ->setName('updated')
                ->update();
            (new CompositeAccount())->connect($db)
                ->setTenantId(734002)
                ->setAccountId(1)
                ->setName('ignored')
                ->duplication((new CompositeAccount())->setName('upserted'))
                ->create();

            $row = (new CompositeAccount())->connect($db)->getByTenantIdAndAccountId(734002, 1);
            self::assertSame('upserted', $row?->getName());
            self::assertSame(1, (new CompositeAccount())->connect($db)->tenantId(734002)->getCount());

            (new CompositeAccount())->connect($db)->tenantId(734002)->gets()->delete();
            self::assertSame(0, (new CompositeAccount())->connect($db)->tenantId(734002)->getCount());
        } finally {
            $db->close();
            unlink($path);
        }
    }

    public function testNativeModelDeleteLockKeepsLoadedChildren(): void
    {
        self::assertTrue((new ReflectionMethod(Model::class, 'deleteLock'))->isInternal());

        $path = tempnam(sys_get_temp_dir(), 'orm-model-delete-lock-native-');
        self::assertNotFalse($path);
        $db = \Polyspec\Orm\Tests\Model\connect(
            'sqlite://' . $path,
            new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'),
        );
        try {
            \Polyspec\Orm\Tests\installBench($db);
            $deleteEvents = [];
            $db->subscribe(static function (\Polyspec\Orm\StatementEvent $event) use (&$deleteEvents): void {
                if ($event->kind === \Polyspec\Orm\StatementEvent::DELETE) {
                    $deleteEvents[] = $event->tables;
                }
            });
            foreach ([false, true] as $locked) {
                $service = (new Service())->connect($db)->setName('delete-lock-service')->create();
                $user = (new User())->connect($db)->setName('delete-lock-user')->create();
                $memberOwner = (new User())->connect($db)->setName('delete-lock-member-owner')->create();
                $region = (new ServiceRegion())->connect($db)
                    ->setServiceSeq($service->getSeq())
                    ->setName('delete-lock-region')
                    ->create();
                $member = (new ServiceMember())->connect($db)
                    ->setServiceSeq($service->getSeq())
                    ->setUserSeq($memberOwner->getSeq())
                    ->create();
                $author = (new Author())->connect($db)
                    ->setName('delete-lock-author')
                    ->setUserSeq($user->getSeq())
                    ->setServiceSeq($service->getSeq())
                    ->setServiceRegionSeq($region->getSeq())
                    ->setServiceMemberSeq($member->getSeq())
                    ->setStartDt('2026-01-01 00:00:00')
                    ->setEndDt('2026-12-31 00:00:00')
                    ->create();

                $relation = (new Author())->matchSeqWithUserSeq();
                if ($locked) {
                    $relation->deleteLock();
                }
                $loaded = (new User())->connect($db)
                    ->seq($user->getSeq())
                    ->relations($relation)
                    ->gets();
                self::assertSame(1, (new Author())->connect($db)->userSeq($user->getSeq())->getCount());
                self::assertSame(0, (new ServiceMember())->connect($db)->userSeq($user->getSeq())->getCount());
                self::assertCount(1, $loaded->first()->getAuthorModels());
                $rowProperty = new \ReflectionProperty(Model::class, 'row');
                $row = $rowProperty->getValue($loaded->first());
                self::assertSame(['author_models'], array_keys($row['related']));
                self::assertSame(['author_models'], array_keys($row['cascade']));
                self::assertInstanceOf(Collection::class, $row['related']['author_models']);
                self::assertSame([!$locked], array_values($row['cascade']));

                $deleteEventStart = count($deleteEvents);
                $deleteError = null;
                try {
                    $loaded->delete(true);
                } catch (OrmException $error) {
                    $deleteError = $error;
                }
                $attemptedDeletes = array_slice($deleteEvents, $deleteEventStart);
                if ($locked) {
                    self::assertSame(
                        Code::FOREIGN_KEY,
                        $deleteError?->code_,
                        'a locked child keeps the user delete blocked; attempted deletes: '
                            . json_encode($attemptedDeletes),
                    );
                    self::assertSame([['user']], $attemptedDeletes, 'a locked child is not deleted recursively');
                    self::assertSame(1, (new Author())->connect($db)->userSeq($user->getSeq())->getCount());
                    self::assertSame(1, (new User())->connect($db)->seq($user->getSeq())->getCount());
                } else {
                    self::assertNull(
                        $deleteError,
                        'unlocked recursive delete should succeed; attempted deletes: '
                            . json_encode($attemptedDeletes),
                    );
                    self::assertSame([['author'], ['user']], $attemptedDeletes, 'children delete before their parent');
                    self::assertSame(0, (new Author())->connect($db)->userSeq($user->getSeq())->getCount());
                    self::assertSame(0, (new User())->connect($db)->seq($user->getSeq())->getCount());
                }
            }
        } finally {
            $db->close();
            unlink($path);
        }
    }
}
