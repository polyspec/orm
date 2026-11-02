<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Request;

// Requirements: CPX-4.
/**
 * The shared plan cache key vector of contracts/fixtures/plan_cache_composite.json through the native
 * Request::canonicalize. Each case of the vector is one data set of the test method, named by its ID.
 */
#[Small]
final class PlanCacheCompositeNativeTest extends TestCase
{
    /** The cases of the vector, keyed by their IDs. */
    public static function cases(): iterable
    {
        yield 'plan_cache_composite_parameter_order' => ['plan_cache_composite_parameter_order'];
        yield 'plan_cache_predicate_fn_parameter_order' => ['plan_cache_predicate_fn_parameter_order'];
    }

    #[DataProvider('cases')]
    public function testPlanCacheCompositeParameterOrder(string $case): void
    {
        $path = dirname(__DIR__, 3) . '/contracts/fixtures/plan_cache_composite.json';
        $vector = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        if ($case === 'plan_cache_composite_parameter_order') {
            $this->assertComposite($vector);
        } else {
            $this->assertPredicate($vector['predicate_fn_param']);
        }
    }

    /** @param array<string, mixed> $vector */
    private function assertComposite(array $vector): void
    {
        $request = new Request('all', 'h');
        $request->ir = $vector['request'];
        $request->params = $vector['params'];
        $request->canonicalize();
        $ir = $request->ir;
        $want = $vector['canonical'];
        self::assertSame($want['params'], $request->params);
        self::assertSame($want['n_params'], count($request->params));
        self::assertSame(
            ['offset_p' => $want['limit']['offset_p'], 'count_p' => $want['limit']['count_p']],
            $ir['limit'],
        );
        self::assertSame($want['if_parent_p'], $ir['if_parent']['p']);
        self::assertSame($want['set_p'], array_map(fn (array $a): int => $a['p'], $ir['set']));
        self::assertSame($want['on_duplicate_p'], array_map(fn (array $a): int => $a['p'], $ir['on_duplicate']));
        self::assertSame($want['rows'], $ir['rows']);
        self::assertSame($want['optimistic_p'], $ir['optimistic']['p']);
    }

    /** @param array<string, mixed> $vector */
    private function assertPredicate(array $vector): void
    {
        $request = new Request('all', 'h');
        $request->ir = $vector['request'];
        $request->params = $vector['params'];
        $request->canonicalize();
        $want = $vector['canonical'];
        self::assertSame($want['params'], $request->params);
        self::assertSame($want['n_params'], count($request->params));
        $pred = $request->ir['where']['items'][0]['pred'];
        self::assertSame($want['where_p'], $pred['p']);
        self::assertSame($want['fn_ps'], $pred['fn']['ps']);
    }
}
