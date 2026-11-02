<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\CanonicalRequest;

// Requirements: CPX-4.
/**
 * The plan cache key of a composite request (T169-3): the shared vector of contracts/fixtures/plan_cache_composite.json
 * through the canonical request of the PHP library.
 */
#[Small]
final class PlanCacheCompositeTest extends TestCase
{
    use PlanCacheCompositeCases;

    private static function canonical(array $ir, array $params): array
    {
        return CanonicalRequest::of($ir, $params);
    }
}
