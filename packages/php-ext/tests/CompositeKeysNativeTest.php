<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use PDO;
use PDOStatement;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use ReflectionClass;

#[Small]
final class CompositeKeysNativeTest extends TestCase
{
    // Requirements: PRT-12.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_composite_relation_binds_and_assembles_both_key_components(): void
    {
        Assert::assertTrue((new ReflectionClass(Db::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Collection::class))->isInternal());

        require_once __DIR__ . '/NativeQueryProbeStatement.php';
        require_once __DIR__ . '/NativeQueryProbePdo.php';
        $pdo = new NativeQueryProbePdo();
        $pdo->exec(
            'CREATE TABLE "composite_account" ("tenant_id" INTEGER NOT NULL, "account_id" INTEGER NOT NULL, '
            . '"name" TEXT NOT NULL, PRIMARY KEY ("tenant_id", "account_id"))'
        );
        $pdo->exec(
            'CREATE TABLE "composite_membership" ("tenant_id" INTEGER NOT NULL, "account_id" INTEGER NOT NULL, '
            . '"role" TEXT NOT NULL, PRIMARY KEY ("tenant_id", "account_id"))'
        );
        $insertAccount = $pdo->prepare('INSERT INTO "composite_account" VALUES (?, ?, ?)');
        $insertMembership = $pdo->prepare('INSERT INTO "composite_membership" VALUES (?, ?, ?)');
        Assert::assertInstanceOf(PDOStatement::class, $insertAccount);
        Assert::assertInstanceOf(PDOStatement::class, $insertMembership);
        Assert::assertTrue($insertAccount->execute([1, 23, 'first']));
        Assert::assertTrue($insertAccount->execute([12, 3, 'second']));
        Assert::assertTrue($insertMembership->execute([1, 23, 'first-role']));
        Assert::assertTrue($insertMembership->execute([12, 3, 'second-role']));
        $pdo->executions = [];

        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $db->registerSet(\Polyspec\Orm\Tests\Model\schema());
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

            Assert::assertSame(['1/23' => ['first-role'], '12/3' => ['second-role']], $relations);
            Assert::assertCount(2, $pdo->executions, 'the root and relation each execute one native statement');
            Assert::assertSame([1, 23, 12, 3], $pdo->executions[1]['params']);
            Assert::assertMatchesRegularExpression(
                '/WHERE \("a"\."tenant_id", "a"\."account_id"\) IN \(\(\?, \?\), \(\?, \?\)\)/',
                $pdo->executions[1]['sql']
            );
        } finally {
            $db->close();
        }
    }
}
