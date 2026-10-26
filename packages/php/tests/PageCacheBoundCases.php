<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use ReflectionClass;
use ReflectionProperty;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Planner;
use Polyspec\Orm\Request;
use Polyspec\Orm\RuntimeModel;

/** The shared page-cache cases run by both the PHP library owner and the native extension owner. */
trait PageCacheBoundCases
{
    // Requirements: CPX-4.
    public function testInListLengthsShareBucketedPlans(): void
    {
        $model = RuntimeModel::build(
            RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.dbs'])
        );
        $engine = new Engine($model, 'sqlite', 1024);
        $cache = new ReflectionProperty(Engine::class, 'plans');
        for ($n = 1; $n <= 300; $n++) {
            $r = new Request('all', $model->manifestHash);
            $r->ir['entity'] = 'load_probe';
            $ps = [];
            for ($i = 0; $i < $n; $i++) {
                $ps[] = $r->param((int) $i);
            }
            $r->ir['where'] = ['items' => [['pred' => ['column' => 'seq', 'op' => 'in', 'ps' => $ps]]]];
            $r->canonicalize();
            $engine->plan($r->shape());
            $entries = count($cache->getValue($engine));
            $this->assertLessThanOrEqual(
                10,
                $entries,
                "length $n: plan cache holds $entries entries, want at most 10 (one per bucketed shape)"
            );
        }
    }

    // Requirements: CPX-4.
    public function testInListPaddingKeepsTheCompiledShape(): void
    {
        if (getenv('ORM_PHP_MODE') === 'extension') {
            $this->assertTrue((new ReflectionClass(Request::class))->isInternal());
            $this->assertTrue((new ReflectionClass(Request::class))->getMethod('canonicalize')->isInternal());
            $this->assertTrue((new ReflectionClass(Planner::class))->isInternal());
            $this->assertTrue((new ReflectionClass(Planner::class))->getMethod('compile')->isInternal());
        }
        $model = RuntimeModel::build(
            RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.dbs'])
        );
        $makeRequest = static function (array $values) use ($model): Request {
            $inIndexes = range(0, count($values) - 2);
            $request = new Request('all', $model->manifestHash);
            $request->ir = [
                'ir_version' => 1,
                'manifest_hash' => $model->manifestHash,
                'kind' => 'all',
                'entity' => 'load_probe',
                'where' => ['items' => [
                    ['pred' => ['column' => 'seq', 'op' => 'in', 'ps' => $inIndexes]],
                    ['pred' => ['column' => 'label', 'op' => 'eq', 'p' => count($values) - 1]],
                ]],
            ];
            $request->params = $values;
            $request->canonicalize();
            return $request;
        };
        foreach (['mysql', 'postgres', 'sqlite'] as $driver) {
            $firstSql = null;
            foreach ([['a', 'b', 'c', 'tail'], ['a', 'b', 'c', 'd', 'tail']] as $index => $values) {
                $request = $makeRequest($values);
                $this->assertSame([0, 1, 2, 3], $request->ir['where']['items'][0]['pred']['ps']);
                $this->assertSame(4, $request->ir['where']['items'][1]['pred']['p']);
                $this->assertSame(
                    $index === 0 ? ['a', 'b', 'c', 'c', 'tail'] : ['a', 'b', 'c', 'd', 'tail'],
                    $request->params
                );
                $plan = (new Engine($model, $driver, 8))->plan($request->shape());
                $step = $plan['steps'][0];
                $this->assertSame([0, 1, 2, 3, 4], array_column($step['bind_slots'], 'param'));
                if ($firstSql === null) {
                    $firstSql = $step['sql'];
                } else {
                    $this->assertSame($firstSql, $step['sql'], "$driver SQL changed within one IN bucket");
                }
            }
        }
    }

    // Requirements: PRT-78; T236.
    public function testPagedReadsSharePlanAndBindPageValues(): void
    {
        if (getenv('ORM_PHP_MODE') === 'extension') {
            $this->assertTrue((new ReflectionClass(Request::class))->isInternal());
            $this->assertTrue((new ReflectionClass(Request::class))->getMethod('canonicalize')->isInternal());
            $this->assertTrue((new ReflectionClass(Planner::class))->isInternal());
            $this->assertTrue((new ReflectionClass(Planner::class))->getMethod('compile')->isInternal());
        }
        $model = RuntimeModel::build(
            RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.dbs'])
        );
        foreach (['mysql', 'postgres', 'sqlite'] as $driver) {
            $engine = new Engine($model, $driver, 1024);
            $cache = new ReflectionProperty(Engine::class, 'plans');
            for ($page = 0; $page < 300; $page++) {
                $request = [
                    'ir_version' => 1,
                    'manifest_hash' => $model->manifestHash,
                    'kind' => 'all',
                    'entity' => 'load_probe',
                    'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => 0]]]],
                    'limit' => ['offset' => $page * 20, 'count' => 20],
                ];
                $built = new Request('all', $model->manifestHash);
                $built->ir = $request;
                $built->params = ['where'];
                $built->canonicalize();
                $canonical = $built->shape();
                $params = $built->params;
                $this->assertSame(['offset_p' => 1, 'count_p' => 2], $canonical['limit']);
                $this->assertSame(['where', $page * 20, 20], $params);
                $plan = $engine->plan($canonical);
                $step = $plan['steps'][0];
                $expected = $driver === 'mysql' ? [0, 1, 2] : [0, 2, 1];
                $this->assertSame(
                    $expected,
                    array_column($step['bind_slots'], 'param'),
                    "$driver page $page bind order"
                );
                $this->assertCount(1, $cache->getValue($engine), "$driver page $page cache entries");
                $this->assertStringContainsString(' LIMIT ', $step['sql']);
            }
        }
    }

    // Requirements: T236.
    public function testCompositeRequestParametersFollowTheSpecifiedRecursiveWalk(): void
    {
        $pred = static fn (int $p): array => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => $p]]]];
        $request = new Request('all', 'h');
        $request->params = array_map(static fn (int $i): string => "v$i", range(0, 17));
        $request->ir = [
            'ir_version' => 1,
            'manifest_hash' => 'h',
            'kind' => 'all',
            'entity' => 'root',
            'columns' => [
                'fn' => [
                    'z_fn' => ['column' => 'seq', 'fn' => ['name' => 'year', 'ps' => [0]]],
                    'a_fn' => ['column' => 'seq', 'fn' => ['name' => 'year', 'ps' => [1]]],
                ],
                'sub' => [
                    'z_sub' => ['column' => 'seq', 'query' => ['entity' => 'inner', 'where' => $pred(2)]],
                    'a_sub' => ['column' => 'seq', 'query' => ['entity' => 'inner', 'where' => $pred(3)]],
                ],
            ],
            'on' => $pred(4),
            'where' => $pred(5),
            'joins' => [[
                'rel' => 'j',
                'kind' => 'inner',
                'query' => ['entity' => 'joined', 'on' => $pred(6), 'where' => $pred(7)],
            ]],
            'relations' => [
                [
                    'rel' => 'r1',
                    'query' => [
                        'entity' => 'related',
                        'where' => $pred(8),
                        'if_parent' => ['column' => 'seq', 'p' => 9],
                    ],
                ],
                ['rel' => 'r2', 'query' => ['entity' => 'related', 'where' => $pred(10)]],
            ],
            'order' => [['column' => 'seq', 'fn' => ['name' => 'year', 'ps' => [11]]]],
            'limit' => ['offset' => 0, 'count' => 20],
            'if_parent' => ['column' => 'seq', 'p' => 12],
            'set' => [['column' => 'seq', 'p' => 13]],
            'on_duplicate' => [['column' => 'seq', 'p' => 14]],
            'rows' => [[15]],
            'optimistic' => ['column' => 'seq', 'p' => 16],
            'n_params' => 18,
        ];
        $request->canonicalize();
        $expectedParams = [
            'v1', 'v0', 'v3', 'v2', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9',
            'v10', 'v11', 0, 20, 'v12', 'v13', 'v14', 'v15', 'v16', 'v17',
        ];
        self::assertSame(
            $expectedParams,
            $request->params
        );
        self::assertSame(['offset_p' => 12, 'count_p' => 13], $request->ir['limit']);
        self::assertSame(14, $request->ir['if_parent']['p']);
        self::assertSame(15, $request->ir['set'][0]['p']);
        self::assertSame(16, $request->ir['on_duplicate'][0]['p']);
        self::assertSame([[17]], $request->ir['rows']);
        self::assertSame(18, $request->ir['optimistic']['p']);
    }

    // Requirements: T236.
    public function testRootPageParametersRejectInvalidValuesAndShapes(): void
    {
        $model = RuntimeModel::build(
            RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.dbs'])
        );
        $engine = new Engine($model, 'sqlite', 1024);
        $warm = new Request('all', $model->manifestHash);
        $warm->ir = [
            'ir_version' => 1,
            'manifest_hash' => $model->manifestHash,
            'kind' => 'all',
            'entity' => 'load_probe',
            'limit' => ['offset' => 0, 'count' => 2],
        ];
        $warm->canonicalize();
        $engine->plan($warm->shape());
        $this->assertCount(1, (new ReflectionProperty(Engine::class, 'plans'))->getValue($engine));
        $request = [
            'ir_version' => 1,
            'manifest_hash' => 'h',
            'kind' => 'all',
            'entity' => 'load_probe',
            'limit' => ['offset_p' => 0, 'count_p' => 1],
            'n_params' => 2,
        ];
        foreach ([null, false, '1', 1.5, 9_007_199_254_740_992] as $value) {
            try {
                $this->canonicalizePage($request, [$value, 2]);
                $this->fail('invalid page value was accepted');
            } catch (\Polyspec\Orm\OrmException $error) {
                $this->assertSame('CODEC_ENCODE', $error->code_);
            }
        }
        foreach ([[-1, 2], [0, 0]] as $values) {
            try {
                $this->canonicalizePage($request, $values);
                $this->fail('out-of-range page value was accepted');
            } catch (\Polyspec\Orm\OrmException $error) {
                $this->assertSame('IR_INVALID', $error->code_);
            }
        }
        foreach (
            [
                ['offset' => 9_007_199_254_740_992, 'count' => 1],
                ['offset' => 0, 'count' => 9_007_199_254_740_992],
            ] as $limit
        ) {
            $literal = [...$request, 'limit' => $limit];
            try {
                $this->canonicalizePage($literal, []);
                $this->fail('unsafe page literal was accepted');
            } catch (\Polyspec\Orm\OrmException $error) {
                $this->assertSame('CODEC_ENCODE', $error->code_);
            }
        }
        foreach (
            [
                ['offset' => 0],
                ['offset' => 0, 'count' => 2, 'offset_p' => 0, 'count_p' => 1],
                ['offset_p' => 0],
            ] as $limit
        ) {
            $bad = [...$request, 'limit' => $limit];
            try {
                $this->canonicalizePage($bad, [0, 2]);
                $this->fail('malformed page shape was accepted');
            } catch (\Polyspec\Orm\OrmException $error) {
                $this->assertSame('IR_INVALID', $error->code_);
            }
        }
    }

    private function canonicalizePage(array $ir, array $params): void
    {
        $request = new Request('all', 'h');
        $request->ir = $ir;
        $request->params = $params;
        $request->canonicalize();
    }
}
