<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use PDOStatement;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\CompositeAccount;
use Polyspec\Orm\Tests\Model\CompositeMembership;
use Polyspec\Orm\Tests\Model\Service;
use Polyspec\Orm\OrmException;

#[Small]
final class ParameterChunkingNativeTest extends TestCase
{
    // Requirements: PLN-44, PRT-76.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_root_in_chunks_use_native_model_queries_and_reject_unmergeable_pages(): void
    {
        require_once __DIR__ . '/NativeQueryProbeStatement.php';
        require_once __DIR__ . '/NativeQueryProbePdo.php';
        NativeQueryProbePdo::assertNativeOrmClasses();
        $pdo = new NativeQueryProbePdo();
        $pdo->exec('CREATE TABLE "service" ("seq" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)');
        $insert = $pdo->prepare('INSERT INTO "service" ("seq", "name") VALUES (?, ?)');
        Assert::assertInstanceOf(PDOStatement::class, $insert);
        for ($seq = 1; $seq <= 1001; $seq++) {
            Assert::assertTrue($insert->execute([$seq, "service-$seq"]));
        }

        $pdo->executions = [];
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $db->registerSet(\Polyspec\Orm\Tests\Model\schema());
        try {
            $values = array_merge(range(1, 1001), range(1, 25), [2001]);
            $rows = (new Service())($db)->seq($values)->gets();
            $sequences = [];
            foreach ($rows as $row) {
                $sequences[] = $row->getSeq();
            }
            Assert::assertSame(range(1, 1001), $sequences, 'split rows are merged in query order without duplicates');
            Assert::assertCount(2, $pdo->executions, 'the SQLite bind limit splits the root IN into two statements');
            Assert::assertSame(range(1, 512), $pdo->executions[0]['params']);
            Assert::assertSame(array_merge(range(513, 1001), array_fill(0, 23, 2001)), $pdo->executions[1]['params']);
            Assert::assertSame(512, substr_count($pdo->executions[0]['sql'], '?'));
            Assert::assertSame(512, substr_count($pdo->executions[1]['sql'], '?'));

            try {
                (new Service())($db)->seq($values)->limit(0, 10)->gets();
                self::fail('a split root page must fail before a statement is executed');
            } catch (OrmException $error) {
                Assert::assertSame(\Polyspec\Orm\Code::IR_INVALID, $error->code_);
            }
            Assert::assertCount(2, $pdo->executions, 'the rejected page sent no additional statement');
        } finally {
            $db->close();
        }
    }

    // A root IN list over the bind limit is split before it is planned, so no plan holds a bind slot per value: a plan
    // costs about 1.6 KB per bind slot, and the plan of these 70300 values alone took 113 MB of PHP memory. The split
    // plans hold at most the bind limit; what the count holds above that is the request's own values.
    public function testSplitRootInCountPlansNoStatementOverTheBindLimit(): void
    {
        require_once __DIR__ . '/NativeQueryProbeStatement.php';
        require_once __DIR__ . '/NativeQueryProbePdo.php';
        NativeQueryProbePdo::assertNativeOrmClasses();
        $pdo = new NativeQueryProbePdo();
        $pdo->exec('CREATE TABLE "service" ("seq" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)');
        $pdo->exec('INSERT INTO "service" ("seq", "name") VALUES (1, \'first\'), (70300, \'last\')');
        $pdo->executions = [];
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $db->registerSet(\Polyspec\Orm\Tests\Model\schema());
        try {
            $values = range(1, 70300);
            memory_reset_peak_usage();
            $start = memory_get_usage();
            $count = (new Service())($db)->seq($values)->getCount();
            $peak = memory_get_peak_usage() - $start;
            Assert::assertSame(2, $count);
            Assert::assertCount(138, $pdo->executions, 'the SQLite bind limit splits 70300 values into 138 statements');
            foreach ($pdo->executions as $execution) {
                Assert::assertLessThanOrEqual(999, count($execution['params']));
            }
            $held = sprintf('the split count held %.1f MB above its start', $peak / 1048576);
            Assert::assertLessThan(32 * 1024 * 1024, $peak, $held);
        } finally {
            $db->close();
        }
    }

    // PRT-76: relation key tuples split at the bind limit and the tail pads to a power-of-two size class.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_composite_relation_keys_split_and_pad_to_bind_safe_size_classes(): void
    {
        require_once __DIR__ . '/NativeQueryProbeStatement.php';
        require_once __DIR__ . '/NativeQueryProbePdo.php';
        NativeQueryProbePdo::assertNativeOrmClasses();
        $rows = [];
        for ($key = 1; $key <= 259; $key++) {
            $tenant = 500 + intdiv($key - 1, 10);
            $accountId = (($key - 1) % 10) + 1;
            $rows[] = [
                'tenantId' => $tenant,
                'accountId' => $accountId,
                'name' => "account-$key",
                'role' => "role-$key",
            ];
        }
        $pdo = NativeQueryProbePdo::withCompositeRows($rows);
        $db = $pdo->connectOrm();
        try {
            $child = (new CompositeMembership())
                ->matchTenantIdWithTenantId()
                ->matchAccountIdWithAccountId()
                ->aliasMemberships();
            $accounts = (new CompositeAccount())($db)->relations($child)->gets();
            Assert::assertCount(259, $accounts);
            foreach ($accounts as $parent) {
                $children = $parent->getMemberships();
                Assert::assertCount(1, $children);
                Assert::assertSame($parent->getTenantId(), $children->first()->getTenantId());
                Assert::assertSame($parent->getAccountId(), $children->first()->getAccountId());
            }

            Assert::assertCount(3, $pdo->executions, 'one root query and two native relation chunks');
            Assert::assertCount(512, $pdo->executions[1]['params'], '256 two-column tuples fit the first chunk');
            Assert::assertCount(8, $pdo->executions[2]['params'], 'the 3-tuple tail pads to the 4-tuple size class');
            Assert::assertSame(512, substr_count($pdo->executions[1]['sql'], '?'));
            Assert::assertSame(8, substr_count($pdo->executions[2]['sql'], '?'));
            $tailTuples = array_chunk(array_slice($pdo->executions[2]['params'], -8), 2);
            Assert::assertNotSame($tailTuples[0], $tailTuples[1]);
            Assert::assertNotSame($tailTuples[1], $tailTuples[2]);
            Assert::assertSame($tailTuples[2], $tailTuples[3], 'the last parent tuple fills the padded slots');
        } finally {
            $db->close();
        }
    }
}
