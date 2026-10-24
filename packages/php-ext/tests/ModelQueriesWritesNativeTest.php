<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Collection;
use Polyspec\Orm\Config;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\Model\CompositeAccount;
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
}
