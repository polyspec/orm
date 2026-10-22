<?php

declare(strict_types=1);

// composite_keys feature coverage: composite_account with a two-column primary key and
// composite_membership that refers to that key (ON DELETE CASCADE) are written, read, and removed for tenants 990004
// and
// 990006. The memberships relation links the two parts of the foreign key
// (tenant_id, account_id) in key order. Account 2 must also exist in another tenant,
// so that a relation linked only by the account_id part is exposed.

require_once __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

const COMPOSITE_TENANT = 990004;
const COMPOSITE_OTHER_TENANT = 990006;

#[Medium]
final class CoverageCompositeKeysTest extends TestCase
{
    // Requirements: PRT-12.
    public function testCompositeKeyRows(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            $accounts = static fn(int $tenant) => (new CompositeAccount())($db)->tenantId($tenant)->getCount();
            $memberships = static fn(int $tenant) => (new CompositeMembership())($db)->tenantId($tenant)->getCount();
            $tenants = [COMPOSITE_TENANT, COMPOSITE_OTHER_TENANT];
            try {
                foreach ($tenants as $tenant) {
                    Assert::assertTrue(
                        $accounts($tenant) === 0 && $memberships($tenant) === 0,
                        "tenant $tenant has rows before the case"
                    );
                }
                coverageRestoring(function () use ($db, $accounts, $memberships, $tenants): void {
                    (new CompositeAccount())($db)->setTenantId(COMPOSITE_TENANT)
                        ->setAccountId(1)
                        ->setName('a')
                        ->create();
                    (new CompositeAccount())($db)->setTenantId(COMPOSITE_TENANT)
                        ->setAccountId(2)
                        ->setName('b')
                        ->create();
                    (new CompositeAccount())($db)->setTenantId(COMPOSITE_OTHER_TENANT)
                        ->setAccountId(2)
                        ->setName('c')
                        ->create();
                    (new CompositeMembership())($db)->setTenantId(COMPOSITE_TENANT)
                        ->setAccountId(1)
                        ->setRole('member')
                        ->create();
                    (new CompositeMembership())($db)->setTenantId(COMPOSITE_TENANT)
                        ->setAccountId(2)
                        ->setRole('owner')
                        ->create();
                    (new CompositeMembership())($db)->setTenantId(COMPOSITE_OTHER_TENANT)
                        ->setAccountId(2)
                        ->setRole('guest')
                        ->create();
                    $name = (new CompositeAccount())($db)->getByTenantIdAndAccountId(COMPOSITE_TENANT, 2)->getName();
                    Assert::assertTrue($name === 'b', "account by both key components is $name, want b");
                    // A child whose relation has its own link reads the parent row first, then reads separately. The
                    // two paths give the same result.
                    foreach (
                        [
                        'same statement' => new CompositeMembership(),
                        'own connection' => (new CompositeMembership())($db)
                        ] as $path => $child
                    ) {
                        $loaded = (new CompositeAccount())($db)->tenantId(COMPOSITE_TENANT)
                            ->relations(
                                $child->matchTenantIdWithTenantId()->matchAccountIdWithAccountId()->aliasMemberships()
                            )
                            ->gets();
                        $got = [];
                        foreach ($loaded as $a) {
                            foreach ($a->getMemberships() as $m) {
                                $got[] = "{$a->getTenantId()}/{$a->getAccountId()}:{$m->getTenantId()}/{$m->getAccountId()}/{$m->getRole()}";
                            }
                        }
                        $want = [
                            COMPOSITE_TENANT . '/1:' . COMPOSITE_TENANT . '/1/member',
                            COMPOSITE_TENANT . '/2:' . COMPOSITE_TENANT . '/2/owner'
                        ];
                        Assert::assertTrue(
                            $got === $want,
                            "$path: memberships of tenant " . COMPOSITE_TENANT . ' accounts ' . json_encode($got)
                        );
                    }
                    (new CompositeAccount())($db)->getByTenantIdAndAccountId(COMPOSITE_TENANT, 2)->delete();
                    Assert::assertTrue(
                        $memberships(COMPOSITE_TENANT) === 1,
                        'ON DELETE CASCADE removed the membership of account 2'
                    );
                    foreach ($tenants as $tenant) {
                        (new CompositeAccount())($db)->tenantId($tenant)->gets()->delete();
                        Assert::assertTrue(
                            $accounts($tenant) === 0 && $memberships($tenant) === 0,
                            "tenant $tenant rows remain after the deletes"
                        );
                    }
                }, function () use ($db, $tenants): void {
                    // The membership is removed by the cascade when the account is deleted, and rows left without an
                    // account are removed too.
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
