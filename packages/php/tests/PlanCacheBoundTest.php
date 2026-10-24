<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/** The PHP library owner runs the shared plan-cache cases against the PHP implementation. */
#[Small]
final class PlanCacheBoundTest extends TestCase
{
    use PageCacheBoundCases;
}
