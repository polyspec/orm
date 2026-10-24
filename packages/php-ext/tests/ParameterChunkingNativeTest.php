<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use PDO;
use PDOStatement;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\Model\Service;
use ReflectionClass;
use Polyspec\Orm\OrmException;

#[Small]
final class ParameterChunkingNativeTest extends TestCase
{
    // Requirements: PRT-76.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_root_in_chunks_use_native_model_queries_and_reject_unmergeable_pages(): void
    {
        Assert::assertTrue((new ReflectionClass(Db::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());

        require_once __DIR__ . '/NativeQueryProbeStatement.php';
        require_once __DIR__ . '/NativeQueryProbePdo.php';
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
}
