<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;

/**
 * The plan cache key vector of a composite request, contracts/fixtures/plan_cache_composite.json (CPX-4), which the
 * PHP library and the extension check each through its own canonical request. Each case of the vector is one data
 * set, named by its ID.
 */
trait PlanCacheCompositeCases
{
    /**
     * The canonical IR and parameters of the request `$ir` with the parameters `$params`.
     *
     * @param array<string, mixed> $ir
     * @param list<mixed> $params
     * @return array{0: array<string, mixed>, 1: list<mixed>}
     */
    abstract private static function canonical(array $ir, array $params): array;

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

    /**
     * The canonical IR of the request of `$vector` and the canonical form that `$vector` expects, after the check
     * of the canonical parameters.
     *
     * @param array<string, mixed> $vector
     * @return array{0: array<string, mixed>, 1: array<string, mixed>}
     */
    private function canonicalParams(array $vector): array
    {
        [$ir, $params] = self::canonical($vector['request'], $vector['params']);
        $want = $vector['canonical'];
        self::assertSame($want['params'], $params);
        self::assertSame($want['n_params'], count($params));
        return [$ir, $want];
    }

    /** @param array<string, mixed> $vector */
    private function assertComposite(array $vector): void
    {
        [$ir, $want] = $this->canonicalParams($vector);
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
        [$ir, $want] = $this->canonicalParams($vector);
        $pred = $ir['where']['items'][0]['pred'];
        self::assertSame($want['where_p'], $pred['p']);
        self::assertSame($want['fn_ps'], $pred['fn']['ps']);
    }
}
