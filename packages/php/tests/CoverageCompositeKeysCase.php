<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use PHPUnit\Framework\Assert;

final class CoverageCompositeKeysCase
{
    private static function childFactories(Db $db): array
    {
        return [
            'same statement' => static fn(): CompositeMembership => new CompositeMembership(),
            'own connection' => static fn(): CompositeMembership => (new CompositeMembership())($db),
        ];
    }

    private static function relationRows(iterable $accounts): array
    {
        $rows = [];
        foreach ($accounts as $account) {
            foreach ($account->getMemberships() as $membership) {
                $rows[] = $account->getTenantId() . '/' . $account->getAccountId() . ':'
                    . $membership->getTenantId() . '/' . $membership->getAccountId() . '/'
                    . $membership->getRole();
            }
        }
        return $rows;
    }

    private static function parentPlaceholderCount(string $sql): int
    {
        if (str_contains($sql, '?')) {
            return substr_count($sql, '?');
        }
        preg_match_all('/\$\d+/', $sql, $matches);
        return count($matches[0]);
    }

    public static function run(Db $db, int $tenant, int $otherTenant): void
    {
        $accounts = static fn(int $keyTenant) => (new CompositeAccount())($db)->tenantId($keyTenant)->getCount();
        $memberships = static fn(int $keyTenant) => (new CompositeMembership())($db)->tenantId($keyTenant)->getCount();
        $fixture = coverageJson(dirname(__DIR__, 3) . '/contracts/fixtures/composite_key_collision.json');
        Assert::assertSame('composite_keys', $fixture['feature']);
        Assert::assertSame('composite_key_rows', $fixture['cases'][0]['id']);
        $collisionRows = $fixture['cases'][0]['expected'];
        $collisionTenant = $collisionRows[0]['tenant_id'];
        $collisionOtherTenant = $collisionRows[1]['tenant_id'];
        $tenants = [$tenant, $otherTenant, $collisionTenant, $collisionOtherTenant];
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

        coverageRestoring(function () use (
            $db,
            $accounts,
            $memberships,
            $tenant,
            $otherTenant,
            $collisionTenant,
            $collisionOtherTenant,
            $collisionRows,
            $tenants
        ): void {
            (new CompositeAccount())($db)->setTenantId($tenant)->setAccountId(1)->setName('a')->create();
            (new CompositeAccount())($db)->setTenantId($tenant)->setAccountId(2)->setName('b')->create();
            (new CompositeAccount())($db)->setTenantId($tenant)->setAccountId(3)->setName('d')->create();
            (new CompositeAccount())($db)->setTenantId($otherTenant)->setAccountId(2)->setName('c')->create();
            (new CompositeMembership())($db)->setTenantId($tenant)->setAccountId(1)->setRole('member')->create();
            (new CompositeMembership())($db)->setTenantId($tenant)->setAccountId(2)->setRole('owner')->create();
            (new CompositeMembership())($db)->setTenantId($tenant)->setAccountId(3)->setRole('editor')->create();
            (new CompositeMembership())($db)->setTenantId($otherTenant)->setAccountId(2)->setRole('guest')->create();
            foreach ($collisionRows as $row) {
                (new CompositeAccount())($db)->setTenantId($row['tenant_id'])
                    ->setAccountId($row['account_id'])->setName($row['name'])->create();
                (new CompositeMembership())($db)->setTenantId($row['tenant_id'])
                    ->setAccountId($row['account_id'])->setRole($row['role'])->create();
            }

            $name = (new CompositeAccount())($db)->getByTenantIdAndAccountId($tenant, 2)->getName();
            Assert::assertSame('b', $name, 'lookup uses both components of the composite key');

            $relationEvents = [];
            $unsubscribe = $db->subscribe(static function (StatementEvent $event) use (&$relationEvents): void {
                if (
                    $event->kind === StatementEvent::SELECT
                    && str_contains($event->sql, 'composite_membership')
                    && str_contains($event->sql, ' IN (')
                ) {
                    $relationEvents[] = $event;
                }
            });
            foreach (self::childFactories($db) as $path => $newChild) {
                $child = $newChild();
                $loaded = (new CompositeAccount())($db)->tenantId($tenant)
                    ->relations(
                        $child->matchTenantIdWithTenantId()->matchAccountIdWithAccountId()->aliasMemberships()
                    )
                    ->gets();
                $got = self::relationRows($loaded);
                $want = [
                    "$tenant/1:$tenant/1/member",
                    "$tenant/2:$tenant/2/owner",
                    "$tenant/3:$tenant/3/editor",
                ];
                Assert::assertSame($want, $got, "$path: relation matches both components of the composite key");
            }
            $unsubscribe();
            Assert::assertCount(2, $relationEvents, 'both relation paths execute one relation statement');
            foreach ($relationEvents as $event) {
                Assert::assertSame(
                    [$tenant, 1, $tenant, 2, $tenant, 3, $tenant, 3],
                    $event->binds,
                    'three composite parent keys pad by repeating the last tuple'
                );
                Assert::assertSame(
                    8,
                    self::parentPlaceholderCount($event->sql),
                    'four two-column placeholders are sent'
                );
            }

            Assert::assertSame(
                (string)$collisionRows[0]['tenant_id'] . $collisionRows[0]['account_id'],
                (string)$collisionRows[1]['tenant_id'] . $collisionRows[1]['account_id'],
                'the collision fixture has equal concatenated composite keys'
            );
            foreach (self::childFactories($db) as $path => $newChild) {
                $child = $newChild();
                $loaded = (new CompositeAccount())($db)
                    ->tupleTenantIdWithAccountId([
                        [$collisionRows[0]['tenant_id'], $collisionRows[0]['account_id']],
                        [$collisionRows[1]['tenant_id'], $collisionRows[1]['account_id']],
                    ])
                    ->orderByTenantIdAsc()
                    ->orderByAccountIdAsc()
                    ->relations(
                        $child->matchTenantIdWithTenantId()->matchAccountIdWithAccountId()->aliasMemberships()
                    )
                    ->gets();
                $got = self::relationRows($loaded);
                $want = array_map(
                    static fn(array $row): string => $row['tenant_id'] . '/' . $row['account_id'] . ':'
                        . $row['tenant_id'] . '/' . $row['account_id'] . '/' . $row['role'],
                    $collisionRows
                );
                Assert::assertSame(
                    $want,
                    $got,
                    "$path: colliding concatenated composite keys keep relations separate"
                );
            }

            (new CompositeAccount())($db)->getByTenantIdAndAccountId($tenant, 2)->delete();
            Assert::assertSame(2, $memberships($tenant), 'ON DELETE CASCADE removes account 2 membership');
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
