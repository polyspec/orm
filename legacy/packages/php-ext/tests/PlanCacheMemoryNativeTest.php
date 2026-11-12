<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\Service;
use ReflectionProperty;

/** Exercises native plan and statement cache retention and eviction through owned public behavior. */
#[Small]
final class PlanCacheMemoryNativeTest extends TestCase
{
    public function testNativeStatementCachePromotesHitsEvictsAndClearsOnClose(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE "service" ("seq" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)');
        $pdo->exec(
            "INSERT INTO \"service\" (\"seq\", \"name\") VALUES (1, 'one'), (2, 'two'), (3, 'three'), (4, 'four')"
        );
        $db = new Db($pdo, 'sqlite', new Config(statementCacheSize: 2), new DateTimeZone('UTC'));
        $db->registerSet(\Polyspec\Orm\Tests\Model\schema());
        $state = (new ReflectionProperty(Db::class, 'state'))->getValue($db);
        try {
            self::assertCount(4, (new Service())($db)->gets());
            $zeroSql = array_key_first($state->stmts);
            $zeroStatement = $state->stmts[$zeroSql];
            self::assertCount(2, (new Service())($db)->seq([1, 2])->gets());
            $twoSql = array_values(array_diff(array_keys($state->stmts), [$zeroSql]))[0];
            $twoStatement = $state->stmts[$twoSql];
            self::assertCount(4, (new Service())($db)->gets());
            self::assertSame($zeroStatement, $state->stmts[$zeroSql], 'the cache hit reuses the zero-bind query');

            self::assertCount(4, (new Service())($db)->seq([1, 2, 3, 4])->gets());
            $fourSql = array_values(array_diff(array_keys($state->stmts), [$zeroSql]))[0];
            self::assertSame([$zeroSql, $fourSql], $state->stmtOrder, 'the hit promoted zeroSql before eviction');
            self::assertSame(4, $state->stmtRetained, 'the padded four-value query retains four binds');
            self::assertArrayNotHasKey($twoSql, $state->stmts);

            self::assertCount(2, (new Service())($db)->seq([1, 2])->gets());
            self::assertNotSame($twoStatement, $state->stmts[$twoSql], 'the evicted statement is prepared again');
            self::assertSame([$fourSql, $twoSql], $state->stmtOrder);
            self::assertSame(6, $state->stmtRetained);
        } finally {
            $db->close();
        }

        self::assertSame([], $state->stmts);
        self::assertSame([], $state->stmtOrder);
        self::assertSame([], $state->stmtPlaceholders);
        self::assertSame(0, $state->stmtRetained);
    }
}
