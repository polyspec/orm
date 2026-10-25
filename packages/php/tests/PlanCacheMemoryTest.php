<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use PDOStatement;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\DbState;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Request;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Tests\Model\Service;
use ReflectionMethod;
use ReflectionProperty;

/**
 * The plan cache and the statement cache retain at most 8192 placeholders each (limepie P-97, KSTD-7-3-5): a plan holds a
 * bind descriptor per placeholder and a cached PDOStatement its last bound values, and each remainder length of creates()
 * is an entry of its own, so caches bounded only by entry count held about 145 MB at 256 entries each, and a bound of 65535
 * placeholders still kept 25.6 MiB of plans and 34.4 MiB of statements.
 */
#[Small]
final class PlanCacheMemoryTest extends TestCase
{
    private const RETAINED_PLACEHOLDERS = 8192;
    /**
     * The memory that the plan cache may keep (KSTD-7-3-5): 8192 placeholders, measured at 3.2 MiB in the library (about 410
     * bytes each) and 4.6 MiB in the extension (about 590 bytes each).
     */
    private const PLAN_BYTES = 5 * 1048576;
    /**
     * The memory that the statement cache may keep (KSTD-7-3-5): 8192 bound values, measured at 4.3 MiB in the library
     * (about 550 bytes each) and 6.1 MiB in the extension (about 780 bytes each).
     */
    private const STATEMENT_BYTES = 7 * 1048576;

    public function testPlanCacheRetainsAtMostTheBoundOfPlaceholders(): void
    {
        $model = RuntimeModel::build(
            RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.dbs'])
        );
        $engine = new Engine($model, 'sqlite', 256);
        $plans = new ReflectionProperty(Engine::class, 'plans');
        for ($rows = 400; $rows < 500; $rows++) {
            $r = new Request('insert', $model->manifestHash);
            $r->ir['entity'] = 'load_note';
            $r->ir['set'] = [
                ['column' => 'code', 'p' => $r->param('c0')],
                ['column' => 'body', 'p' => $r->param('b0')],
            ];
            for ($i = 1; $i < $rows; $i++) {
                $r->ir['rows'][] = [$r->param("c$i"), $r->param("b$i")];
            }
            $r->canonicalize();
            $engine->plan($r->shape());
        }
        $retained = 0;
        foreach ($plans->getValue($engine) as $plan) {
            foreach ($plan['steps'] as $step) {
                $retained += count($step['bind_slots']);
            }
        }
        $this->assertLessThanOrEqual(
            self::RETAINED_PLACEHOLDERS,
            $retained,
            "100 multi-row insert plans left $retained placeholders in the plan cache"
        );
    }

    /**
     * The memory that the plan cache keeps after 100 multi-row insert plans of 800 to 998 placeholders, each a remainder
     * length of creates() (KSTD-7-3-5): at most PLAN_BYTES, so an import stops growing once the cache is full.
     */
    public function testPlanCacheRetainsAtMostAFewMibOfPlans(): void
    {
        $model = RuntimeModel::build(
            RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.dbs'])
        );
        gc_collect_cycles();
        $before = memory_get_usage();
        $engine = new Engine($model, 'sqlite', 256);
        for ($rows = 400; $rows < 500; $rows++) {
            $engine->plan($this->insertShape($model, $rows));
        }
        gc_collect_cycles();
        $retained = memory_get_usage() - $before;
        $this->assertLessThanOrEqual(
            self::PLAN_BYTES,
            $retained,
            sprintf('100 multi-row insert plans kept %.1f MiB in the plan cache', $retained / 1048576)
        );
        unset($engine);
    }

    /**
     * The memory that the statement cache keeps after 100 multi-row inserts of 900 to 999 rows (KSTD-7-3-5): a cached
     * PDOStatement keeps its last bound values, so the cache keeps at most STATEMENT_BYTES.
     */
    public function testStatementCacheRetainsAtMostAFewMibOfStatements(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE "service" ("seq" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $db->registerSet(\Polyspec\Orm\Tests\Model\schema());
        try {
            // The first insert prepares what every run keeps apart from the cache: the model and the connection state.
            (new Service())($db)->creates([(new Service())->setName('first')], 1);
            gc_collect_cycles();
            $before = memory_get_usage();
            $next = 0;
            for ($batch = 900; $batch < 1000; $batch++) {
                $rows = [];
                for ($i = 0; $i < $batch; $i++) {
                    $rows[] = (new Service())->setName('service-' . $next++);
                }
                (new Service())($db)->creates($rows, $batch);
            }
            unset($rows);
            gc_collect_cycles();
            $retained = memory_get_usage() - $before;
            $this->assertLessThanOrEqual(
                self::STATEMENT_BYTES,
                $retained,
                sprintf('100 multi-row inserts kept %.1f MiB in the statement cache', $retained / 1048576)
            );
        } finally {
            $db->close();
        }
    }

    public function testPlanCachePromotesHitsAndEvictsTheLeastRecentlyUsedPlan(): void
    {
        $model = RuntimeModel::build(
            RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.dbs'])
        );
        $engine = new Engine($model, 'sqlite', 2);
        $plans = new ReflectionProperty(Engine::class, 'plans');
        $firstShape = $this->insertShape($model, 1);
        $secondShape = $this->insertShape($model, 2);
        $thirdShape = $this->insertShape($model, 3);
        $firstKey = $this->shapeKey($firstShape);
        $secondKey = $this->shapeKey($secondShape);
        $thirdKey = $this->shapeKey($thirdShape);

        $firstPlan = $engine->plan($firstShape);
        $secondPlan = $engine->plan($secondShape);
        $this->assertSame($firstPlan, $engine->plan($firstShape), 'a cache hit returns the existing plan');
        $engine->plan($thirdShape);
        $this->assertSame(
            [$firstKey, $thirdKey],
            array_keys($plans->getValue($engine)),
            'the hit promoted the first plan before eviction',
        );

        $replannedSecond = $engine->plan($secondShape);
        $this->assertSame($secondPlan, $replannedSecond, 'evicting and recompiling does not change the plan');
        $this->assertSame([$thirdKey, $secondKey], array_keys($plans->getValue($engine)));
    }

    public function testStatementCacheRetainsAtMostTheBoundOfPlaceholders(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE "service" ("seq" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $db->registerSet(\Polyspec\Orm\Tests\Model\schema());
        try {
            $next = 0;
            for ($batch = 900; $batch < 1000; $batch++) {
                $rows = [];
                for ($i = 0; $i < $batch; $i++) {
                    $rows[] = (new Service())->setName('service-' . $next++);
                }
                (new Service())($db)->creates($rows, $batch);
            }
            $state = (new ReflectionProperty(Db::class, 'state'))->getValue($db);
            $retained = 0;
            foreach (array_keys($state->stmts) as $sql) {
                $retained += substr_count($sql, '?');
            }
            $this->assertLessThanOrEqual(
                self::RETAINED_PLACEHOLDERS,
                $retained,
                "100 multi-row inserts left $retained placeholders in the statement cache"
            );
        } finally {
            $db->close();
        }
    }

    public function testStatementCachePromotesHitsAndEvictsTheLeastRecentlyUsedStatement(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $db = new Db($pdo, 'sqlite', new Config(statementCacheSize: 2), new DateTimeZone('UTC'));
        $stmt = new ReflectionMethod(Db::class, 'stmt');
        $stateProperty = new ReflectionProperty(Db::class, 'state');
        $zeroSql = 'SELECT 42 AS value';
        $twoSql = 'SELECT ? + ? AS value';
        $threeSql = 'SELECT ? + ? + ? AS value';
        try {
            $zero = $this->statement($stmt, $db, $zeroSql, 0);
            $two = $this->statement($stmt, $db, $twoSql, 2);
            $this->assertSame(42, $this->executeValue($zero, []));
            $this->assertSame(5, $this->executeValue($two, [2, 3]));
            $this->assertSame(
                $zero,
                $this->statement($stmt, $db, $zeroSql, 0),
                'a hit reuses the zero-placeholder entry',
            );

            $three = $this->statement($stmt, $db, $threeSql, 3);
            $this->assertSame(6, $this->executeValue($three, [1, 2, 3]));
            $state = $stateProperty->getValue($db);
            $this->assertInstanceOf(DbState::class, $state);
            $this->assertSame(
                [$zeroSql, $threeSql],
                $state->stmtOrder,
                'the hit promoted zeroSql, so twoSql was evicted',
            );
            $this->assertSame(
                3,
                $state->stmtRetained,
                'the zero-placeholder entry does not change the placeholder total',
            );

            $repreparedTwo = $this->statement($stmt, $db, $twoSql, 2);
            $this->assertNotSame($two, $repreparedTwo, 'an evicted statement is prepared again');
            $this->assertSame(9, $this->executeValue($repreparedTwo, [4, 5]));
            $this->assertSame([$threeSql, $twoSql], $state->stmtOrder);
            $this->assertSame(5, $state->stmtRetained);
        } finally {
            $db->close();
        }
    }

    /** @return array<string, mixed> */
    private function insertShape(RuntimeModel $model, int $rows): array
    {
        $request = new Request('insert', $model->manifestHash);
        $request->ir['entity'] = 'load_note';
        $request->ir['set'] = [
            ['column' => 'code', 'p' => $request->param('c0')],
            ['column' => 'body', 'p' => $request->param('b0')],
        ];
        for ($row = 1; $row < $rows; $row++) {
            $request->ir['rows'][] = [$request->param("c$row"), $request->param("b$row")];
        }
        $request->canonicalize();
        return $request->shape();
    }

    /** @param array<string, mixed> $shape */
    private function shapeKey(array $shape): string
    {
        return (string) json_encode(
            $shape,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION,
        );
    }

    /** @param list<mixed> $values */
    private function executeValue(\PDOStatement $statement, array $values): mixed
    {
        $this->assertTrue($statement->execute($values));
        $value = $statement->fetchColumn();
        $statement->closeCursor();
        return $value;
    }

    private function statement(ReflectionMethod $method, Db $db, string $sql, int $placeholders): PDOStatement
    {
        $statement = $method->invoke($db, $sql, $placeholders);
        $this->assertInstanceOf(PDOStatement::class, $statement);
        return $statement;
    }
}
