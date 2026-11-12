<?php

// The performance gate correctness recipe, contracts/fixtures/performance_gate/performance_gate.json, on each database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). The timing of the gate stays in the performance coverage cases.
// Requirements: PERF-1.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class PerformanceGateRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/performance_gate/performance_gate.json';
    }
}
