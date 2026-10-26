<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use ReflectionClass;

#[Small]
final class CompositeKeysNativeTest extends TestCase
{
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- owner fixture check uses the native test naming convention.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- the test symbol keeps its native case name.
    public function test_native_fixture_populates_all_composite_key_columns(): void
    {
        require_once __DIR__ . '/NativeQueryProbeStatement.php';
        require_once __DIR__ . '/NativeQueryProbePdo.php';
        $pdo = NativeQueryProbePdo::withCompositeRows([
            ['tenantId' => 1, 'accountId' => 23, 'name' => 'first', 'role' => 'first-role'],
        ]);

        Assert::assertSame(
            [1, 23, 'first'],
            $pdo->query('SELECT "tenant_id", "account_id", "name" FROM "composite_account"')->fetch(\PDO::FETCH_NUM)
        );
        Assert::assertSame(
            [1, 23, 'first-role'],
            $pdo->query('SELECT "tenant_id", "account_id", "role" FROM "composite_membership"')->fetch(\PDO::FETCH_NUM)
        );
        Assert::assertSame([], $pdo->executions, 'fixture setup is not recorded as ORM query execution');
    }

    // Requirements: DSL-82, INT-87, PRT-12, PRT-40.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_composite_relation_binds_and_assembles_both_key_components(): void
    {
        require_once __DIR__ . '/NativeQueryProbeStatement.php';
        require_once __DIR__ . '/NativeQueryProbePdo.php';
        NativeQueryProbePdo::assertNativeOrmClasses();
        Assert::assertTrue((new ReflectionClass(Collection::class))->isInternal());
        $fixture = json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/composite_key_collision.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        Assert::assertSame('composite_keys', $fixture['feature']);
        Assert::assertSame('composite_key_rows', $fixture['cases'][0]['id']);
        $collisionRows = $fixture['cases'][0]['expected'];
        Assert::assertSame(
            (string)$collisionRows[0]['tenant_id'] . $collisionRows[0]['account_id'],
            (string)$collisionRows[1]['tenant_id'] . $collisionRows[1]['account_id'],
            'the shared fixture has equal concatenated composite keys'
        );
        $nativeRows = array_map(
            static fn(array $row): array => [
                'tenantId' => $row['tenant_id'],
                'accountId' => $row['account_id'],
                'name' => $row['name'],
                'role' => $row['role'],
            ],
            $collisionRows
        );
        $nativeRows[] = ['tenantId' => 990004, 'accountId' => 3, 'name' => 'd', 'role' => 'editor'];
        $pdo = NativeQueryProbePdo::withCompositeRows($nativeRows);
        $db = $pdo->connectOrm();
        try {
            $membership = (new CompositeMembership())
                ->matchTenantIdWithTenantId()
                ->matchAccountIdWithAccountId()
                ->aliasMemberships();
            $accounts = (new CompositeAccount())($db)->relations($membership)->gets();
            $relations = [];
            foreach ($accounts as $account) {
                $roles = [];
                foreach ($account->getMemberships() as $row) {
                    $roles[] = $row->getRole();
                }
                $relations[$account->getTenantId() . '/' . $account->getAccountId()] = $roles;
            }

            $expectedRelations = [];
            foreach ($collisionRows as $row) {
                $expectedRelations[$row['tenant_id'] . '/' . $row['account_id']] = [$row['role']];
            }
            $expectedRelations['990004/3'] = ['editor'];
            Assert::assertSame($expectedRelations, $relations);
            Assert::assertCount(2, $pdo->executions, 'the root and relation each execute one native statement');
            Assert::assertSame(
                [
                    $collisionRows[0]['tenant_id'],
                    $collisionRows[0]['account_id'],
                    $collisionRows[1]['tenant_id'],
                    $collisionRows[1]['account_id'],
                    990004,
                    3,
                    990004,
                    3,
                ],
                $pdo->executions[1]['params']
            );
            Assert::assertMatchesRegularExpression(
                '/WHERE \("a"\."tenant_id", "a"\."account_id"\) IN \(\(\?, \?\), \(\?, \?\), \(\?, \?\), \(\?, \?\)\)/',
                $pdo->executions[1]['sql']
            );
        } finally {
            $db->close();
        }
    }


    // DSL-35 and DSL-64: tuple predicates and pages retain every composite key component.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_tuple_predicates_and_pages_keep_the_full_composite_key(): void
    {
        require_once __DIR__ . '/NativeQueryProbeStatement.php';
        require_once __DIR__ . '/NativeQueryProbePdo.php';
        NativeQueryProbePdo::assertNativeOrmClasses();
        $pdo = NativeQueryProbePdo::withCompositeRows([
            ['tenantId' => 1, 'accountId' => 23, 'name' => 'first', 'role' => 'first-role'],
            ['tenantId' => 12, 'accountId' => 3, 'name' => 'second', 'role' => 'second-role'],
            ['tenantId' => 1, 'accountId' => 3, 'name' => 'third', 'role' => 'third-role'],
        ]);
        $db = $pdo->connectOrm();
        try {
            $pairs = (new CompositeAccount())($db)
                ->tupleTenantIdWithAccountId([[1, 23], [12, 3]])
                ->orderByTenantIdAsc()
                ->orderByAccountIdAsc()
                ->gets();
            $keys = [];
            foreach ($pairs as $account) {
                $keys[] = $account->getTenantId() . '/' . $account->getAccountId();
            }
            Assert::assertSame(['1/23', '12/3'], $keys);

            $page = (new CompositeAccount())($db)
                ->orderByTenantIdAsc()
                ->orderByAccountIdAsc()
                ->getsPage(2, 1);
            Assert::assertSame(3, $page->totalCount);
            Assert::assertSame(3, $page->totalPages);
            Assert::assertSame(2, $page->page);
            Assert::assertSame(1, $page->perPage);
            Assert::assertCount(1, $page->items);
            Assert::assertSame(1, $page->items->first()?->getTenantId());
            Assert::assertSame(23, $page->items->first()?->getAccountId());
            Assert::assertSame('first', $page->items->first()?->getName());
        } finally {
            $db->close();
        }
    }
}
