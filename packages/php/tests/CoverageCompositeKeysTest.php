<?php
declare(strict_types=1);
// composite_keys feature coverage: 두 column primary key의 composite_account와
// 그 key를 참조하는 composite_membership(ON DELETE CASCADE)을 tenant 990004와
// 990006으로 쓰고 읽고 지운다. memberships relation은 foreign key의 두 성분
// (tenant_id, account_id)을 key 순서대로 잇는다. 다른 tenant에도 account 2가
// 있어야 account_id 한 성분만으로 잇는 relation이 드러난다.

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
    public function test_composite_key_rows(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [, $dsn] = coverageItem();
            $db = coverageConnect($dsn);
            $accounts = static fn(int $tenant) => (new CompositeAccount)($db)->tenantId($tenant)->getCount();
            $memberships = static fn(int $tenant) => (new CompositeMembership)($db)->tenantId($tenant)->getCount();
            $tenants = [COMPOSITE_TENANT, COMPOSITE_OTHER_TENANT];
            try {
                foreach ($tenants as $tenant) {
                    Assert::assertTrue($accounts($tenant) === 0 && $memberships($tenant) === 0, "tenant $tenant has rows before the case");
                }
                coverageRestoring(function () use ($db, $accounts, $memberships, $tenants): void {
                    (new CompositeAccount)($db)->setTenantId(COMPOSITE_TENANT)->setAccountId(1)->setName('a')->create();
                    (new CompositeAccount)($db)->setTenantId(COMPOSITE_TENANT)->setAccountId(2)->setName('b')->create();
                    (new CompositeAccount)($db)->setTenantId(COMPOSITE_OTHER_TENANT)->setAccountId(2)->setName('c')->create();
                    (new CompositeMembership)($db)->setTenantId(COMPOSITE_TENANT)->setAccountId(1)->setRole('member')->create();
                    (new CompositeMembership)($db)->setTenantId(COMPOSITE_TENANT)->setAccountId(2)->setRole('owner')->create();
                    (new CompositeMembership)($db)->setTenantId(COMPOSITE_OTHER_TENANT)->setAccountId(2)->setRole('guest')->create();
                    $name = (new CompositeAccount)($db)->getByTenantIdAndAccountId(COMPOSITE_TENANT, 2)->getName();
                    Assert::assertTrue($name === 'b', "account by both key components is $name, want b");
                    // 자식이 자기 연결을 가진 relation은 부모 row를 읽은 뒤 따로 읽는다. 두 경로가 같은 결과를 낸다.
                    foreach (['same statement' => new CompositeMembership(), 'own connection' => (new CompositeMembership)($db)] as $path => $child) {
                        $loaded = (new CompositeAccount)($db)->tenantId(COMPOSITE_TENANT)
                            ->relations($child->matchTenantIdWithTenantId()->matchAccountIdWithAccountId()->aliasMemberships())
                            ->gets();
                        $got = [];
                        foreach ($loaded as $a) {
                            foreach ($a->getMemberships() as $m) {
                                $got[] = "{$a->getTenantId()}/{$a->getAccountId()}:{$m->getTenantId()}/{$m->getAccountId()}/{$m->getRole()}";
                            }
                        }
                        $want = [COMPOSITE_TENANT . '/1:' . COMPOSITE_TENANT . '/1/member', COMPOSITE_TENANT . '/2:' . COMPOSITE_TENANT . '/2/owner'];
                        Assert::assertTrue($got === $want, "$path: memberships of tenant " . COMPOSITE_TENANT . ' accounts ' . json_encode($got));
                    }
                    (new CompositeAccount)($db)->getByTenantIdAndAccountId(COMPOSITE_TENANT, 2)->delete();
                    Assert::assertTrue($memberships(COMPOSITE_TENANT) === 1, 'ON DELETE CASCADE removed the membership of account 2');
                    foreach ($tenants as $tenant) {
                        (new CompositeAccount)($db)->tenantId($tenant)->gets()->delete();
                        Assert::assertTrue($accounts($tenant) === 0 && $memberships($tenant) === 0, "tenant $tenant rows remain after the deletes");
                    }
                }, function () use ($db, $tenants): void {
                    // membership은 account 삭제의 cascade로 지워지지만, account 없이 남은 행도 지운다.
                    foreach ($tenants as $tenant) {
                        (new CompositeMembership)($db)->tenantId($tenant)->gets()->delete();
                        (new CompositeAccount)($db)->tenantId($tenant)->gets()->delete();
                    }
                });
            } finally {
                $db->close();
            }
        }
    }
}
