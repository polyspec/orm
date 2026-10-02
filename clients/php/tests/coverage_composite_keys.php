<?php
declare(strict_types=1);
// composite_keys feature coverage: 두 column primary key의 composite_account와
// 그 key를 참조하는 composite_membership(ON DELETE CASCADE)을 tenant 990004로
// 쓰고 읽고 지운다.
// PHP model의 relation은 한 column 쌍(match<L>With<R>)으로 맞추므로,
// memberships relation은 account_id로 맞추고 child 조건으로 tenant를 고정한다.

require __DIR__ . '/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use Orm\Collection;

const COMPOSITE_TENANT = 990004;

runCoverageCases($argv, [
    'composite_key_rows' => function (): void {
        [, $dsn] = coverageDatabase();
        $db = coverageConnect($dsn);
        $accounts = static fn() => (new CompositeAccount)($db)->tenantId(COMPOSITE_TENANT)->getCount();
        $memberships = static fn() => (new CompositeMembership)($db)->tenantId(COMPOSITE_TENANT)->getCount();
        try {
            coverageWant($accounts() === 0 && $memberships() === 0, 'tenant ' . COMPOSITE_TENANT . ' has rows before the case');
            coverageRestoring(function () use ($db, $accounts, $memberships): void {
                (new CompositeAccount)($db)->setTenantId(COMPOSITE_TENANT)->setAccountId(1)->setName('a')->create();
                (new CompositeAccount)($db)->setTenantId(COMPOSITE_TENANT)->setAccountId(2)->setName('b')->create();
                (new CompositeMembership)($db)->setTenantId(COMPOSITE_TENANT)->setAccountId(2)->setRole('owner')->create();
                $name = (new CompositeAccount)($db)->getByTenantIdAndAccountId(COMPOSITE_TENANT, 2)->getName();
                coverageWant($name === 'b', "account by both key components is $name, want b");
                $account = (new CompositeAccount)($db)
                    ->relations((new CompositeMembership)->matchAccountIdWithAccountId()->tenantId(COMPOSITE_TENANT)->aliasMemberships())
                    ->getByTenantIdAndAccountId(COMPOSITE_TENANT, 2);
                $loaded = $account->getMemberships();
                coverageWant($loaded instanceof Collection && count($loaded) === 1 && $loaded->first()->getRole() === 'owner'
                    && $loaded->first()->getTenantId() === COMPOSITE_TENANT && $loaded->first()->getAccountId() === 2,
                    'memberships relation ' . json_encode($loaded));
                $account->delete();
                coverageWant($memberships() === 0, 'the membership of the deleted account remains');
                (new CompositeAccount)($db)->getByTenantIdAndAccountId(COMPOSITE_TENANT, 1)->delete();
                coverageWant($accounts() === 0 && $memberships() === 0, 'tenant rows remain after the deletes');
            }, function () use ($db): void {
                // membership은 account 삭제의 cascade로 지워지지만, account 없이 남은 행도 지운다.
                (new CompositeMembership)($db)->tenantId(COMPOSITE_TENANT)->gets()->delete();
                (new CompositeAccount)($db)->tenantId(COMPOSITE_TENANT)->gets()->delete();
            });
        } finally {
            $db->close();
        }
    },
]);
