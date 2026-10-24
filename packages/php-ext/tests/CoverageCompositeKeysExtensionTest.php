<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use ReflectionClass;

const COMPOSITE_NATIVE_TENANT = 990004;
const COMPOSITE_NATIVE_OTHER_TENANT = 990006;

#[Medium]
final class CoverageCompositeKeysExtensionTest extends TestCase
{
    // Requirements: PRT-12.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_composite_key_rows(): void
    {
        Assert::assertTrue((new ReflectionClass(Db::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Collection::class))->isInternal());
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            $accounts = static fn(int $tenant) => (new CompositeAccount())($db)->tenantId($tenant)->getCount();
            $memberships = static fn(int $tenant) => (new CompositeMembership())($db)->tenantId($tenant)->getCount();
            $tenants = [COMPOSITE_NATIVE_TENANT, COMPOSITE_NATIVE_OTHER_TENANT];
            try {
                foreach ($tenants as $tenant) {
                    Assert::assertTrue(
                        $accounts($tenant) === 0 && $memberships($tenant) === 0,
                        "tenant $tenant has rows before the case"
                    );
                }
                coverageRestoring(function () use ($db, $accounts, $memberships, $tenants): void {
                    (new CompositeAccount())($db)->setTenantId(COMPOSITE_NATIVE_TENANT)
                        ->setAccountId(1)
                        ->setName('a')
                        ->create();
                    (new CompositeAccount())($db)->setTenantId(COMPOSITE_NATIVE_TENANT)
                        ->setAccountId(2)
                        ->setName('b')
                        ->create();
                    (new CompositeAccount())($db)->setTenantId(COMPOSITE_NATIVE_OTHER_TENANT)
                        ->setAccountId(2)
                        ->setName('c')
                        ->create();
                    (new CompositeMembership())($db)->setTenantId(COMPOSITE_NATIVE_TENANT)
                        ->setAccountId(1)
                        ->setRole('member')
                        ->create();
                    (new CompositeMembership())($db)->setTenantId(COMPOSITE_NATIVE_TENANT)
                        ->setAccountId(2)
                        ->setRole('owner')
                        ->create();
                    (new CompositeMembership())($db)->setTenantId(COMPOSITE_NATIVE_OTHER_TENANT)
                        ->setAccountId(2)
                        ->setRole('guest')
                        ->create();
                    $name = (new CompositeAccount())($db)
                        ->getByTenantIdAndAccountId(COMPOSITE_NATIVE_TENANT, 2)->getName();
                    Assert::assertSame('b', $name, 'the full composite key selects account 2');
                    foreach ([new CompositeMembership(), (new CompositeMembership())($db)] as $child) {
                        $loaded = (new CompositeAccount())($db)->tenantId(COMPOSITE_NATIVE_TENANT)
                            ->relations(
                                $child->matchTenantIdWithTenantId()->matchAccountIdWithAccountId()->aliasMemberships()
                            )
                            ->gets();
                        $got = [];
                        foreach ($loaded as $account) {
                            foreach ($account->getMemberships() as $membership) {
                                $got[] = $account->getTenantId() . '/' . $account->getAccountId() . ':'
                                    . $membership->getTenantId() . '/' . $membership->getAccountId() . '/'
                                    . $membership->getRole();
                            }
                        }
                        Assert::assertSame([
                            COMPOSITE_NATIVE_TENANT . '/1:' . COMPOSITE_NATIVE_TENANT . '/1/member',
                            COMPOSITE_NATIVE_TENANT . '/2:' . COMPOSITE_NATIVE_TENANT . '/2/owner',
                        ], $got, 'both components of the relation key attach each child to its parent');
                    }
                    (new CompositeAccount())($db)
                        ->getByTenantIdAndAccountId(COMPOSITE_NATIVE_TENANT, 2)->delete();
                    Assert::assertSame(1, $memberships(COMPOSITE_NATIVE_TENANT));
                    foreach ($tenants as $tenant) {
                        (new CompositeAccount())($db)->tenantId($tenant)->gets()->delete();
                        Assert::assertTrue($accounts($tenant) === 0 && $memberships($tenant) === 0);
                    }
                }, function () use ($db, $tenants): void {
                    foreach ($tenants as $tenant) {
                        (new CompositeMembership())($db)->tenantId($tenant)->gets()->delete();
                        (new CompositeAccount())($db)->tenantId($tenant)->gets()->delete();
                    }
                });
            } finally {
                $db->close();
            }
        }
    }
}
