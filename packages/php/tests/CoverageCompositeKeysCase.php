<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use PHPUnit\Framework\Assert;

final class CoverageCompositeKeysCase
{
    public static function run(Db $db, int $tenant, int $otherTenant): void
    {
        $accounts = static fn(int $keyTenant) => (new CompositeAccount())($db)->tenantId($keyTenant)->getCount();
        $memberships = static fn(int $keyTenant) => (new CompositeMembership())($db)->tenantId($keyTenant)->getCount();
        $tenants = [$tenant, $otherTenant];
        foreach ($tenants as $keyTenant) {
            Assert::assertSame(
                0,
                $accounts($keyTenant),
                "tenant $keyTenant has no composite_account rows before the case"
            );
            Assert::assertSame(
                0,
                $memberships($keyTenant),
                "tenant $keyTenant has no composite_membership rows before the case"
            );
        }

        coverageRestoring(function () use ($db, $accounts, $memberships, $tenant, $otherTenant, $tenants): void {
            (new CompositeAccount())($db)->setTenantId($tenant)->setAccountId(1)->setName('a')->create();
            (new CompositeAccount())($db)->setTenantId($tenant)->setAccountId(2)->setName('b')->create();
            (new CompositeAccount())($db)->setTenantId($otherTenant)->setAccountId(2)->setName('c')->create();
            (new CompositeMembership())($db)->setTenantId($tenant)->setAccountId(1)->setRole('member')->create();
            (new CompositeMembership())($db)->setTenantId($tenant)->setAccountId(2)->setRole('owner')->create();
            (new CompositeMembership())($db)->setTenantId($otherTenant)->setAccountId(2)->setRole('guest')->create();

            $name = (new CompositeAccount())($db)->getByTenantIdAndAccountId($tenant, 2)->getName();
            Assert::assertSame('b', $name, 'lookup uses both components of the composite key');

            foreach (
                [
                    'same statement' => new CompositeMembership(),
                    'own connection' => (new CompositeMembership())($db),
                ] as $path => $child
            ) {
                $loaded = (new CompositeAccount())($db)->tenantId($tenant)
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
                $want = [
                    "$tenant/1:$tenant/1/member",
                    "$tenant/2:$tenant/2/owner",
                ];
                Assert::assertSame($want, $got, "$path: relation matches both components of the composite key");
            }

            (new CompositeAccount())($db)->getByTenantIdAndAccountId($tenant, 2)->delete();
            Assert::assertSame(1, $memberships($tenant), 'ON DELETE CASCADE removes account 2 membership');
            foreach ($tenants as $keyTenant) {
                (new CompositeAccount())($db)->tenantId($keyTenant)->gets()->delete();
                Assert::assertSame(0, $accounts($keyTenant), "tenant $keyTenant accounts are deleted");
                Assert::assertSame(0, $memberships($keyTenant), "tenant $keyTenant memberships are deleted");
            }
        }, static function () use ($db, $tenants): void {
            foreach ($tenants as $keyTenant) {
                (new CompositeMembership())($db)->tenantId($keyTenant)->gets()->delete();
                (new CompositeAccount())($db)->tenantId($keyTenant)->gets()->delete();
            }
        });
    }
}
