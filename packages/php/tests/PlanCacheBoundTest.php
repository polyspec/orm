<?php

declare(strict_types=1);

use Polyspec\Orm\Engine;
use Polyspec\Orm\Request;
use Polyspec\Orm\RuntimeModel;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/**
 * One IN statement with lists of 1 to 300 values keeps at most one plan per power-of-two bucket of the list
 * length (T169-3): the cache holds ten entries (1, 2, 4 ... 512), not one per length.
 */
#[Small]
final class PlanCacheBoundTest extends TestCase
{
    // Requirements: CPX-4.
    public function testInListLengthsShareBucketedPlans(): void
    {
        $model = RuntimeModel::build(RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/identity_load.dbs']));
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
            $this->assertLessThanOrEqual(10, $entries, "length $n: plan cache holds $entries entries, want at most 10 (one per bucketed shape)");
        }
    }
}
