<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Request;
use Polyspec\Orm\Tests\PlanCacheCompositeCases;

// Requirements: CPX-4.
/** The shared plan cache key vector of contracts/fixtures/plan_cache_composite.json through the native Request::canonicalize. */
#[Small]
final class PlanCacheCompositeNativeTest extends TestCase
{
    use PlanCacheCompositeCases;

    private static function canonical(array $ir, array $params): array
    {
        $request = new Request('all', 'h');
        $request->ir = $ir;
        $request->params = $params;
        $request->canonicalize();
        return [$request->ir, $request->params];
    }
}
