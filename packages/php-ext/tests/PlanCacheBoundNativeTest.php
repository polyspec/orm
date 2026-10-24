<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// Requirements: CPX-4.
/** The PHP extension owner runs the same page-cache cases against native Request and Planner classes. */
#[Small]
final class PlanCacheBoundNativeTest extends TestCase
{
    use PageCacheBoundCases;
}
