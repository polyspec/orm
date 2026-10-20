<?php

declare(strict_types=1);

// performance_gate feature coverage: runs packages/php/tests/PerfGateTest.php in a child
// PHPUnit process and passes only when the exit code is 0. The gate's output is not put
// into this test's output; on failure it goes into the error. ORM_BENCH_MYSQL_DSN is the seeded shared bench
// database, and the gate only reads it.

require_once __DIR__ . '/coverage_cases.php';

use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

#[Large]
final class CoveragePerformanceGateTest extends TestCase
{
    public function test_hot_path_gate(): void
    {
        $dsn = getenv('ORM_BENCH_MYSQL_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_BENCH_MYSQL_DSN is required; run it through make orm-check or make run-databases TARGETS=<target>, which create the bench database of the run');
        }
        $package = dirname(__DIR__);
        [$status, $stdout, $stderr] = coverageProcess(
            [PHP_BINARY, dirname(__DIR__, 3) . '/vendor-php/bin/phpunit', '--configuration', "$package/phpunit.xml.dist", __DIR__ . '/PerfGateTest.php'],
            dirname(__DIR__, 3),
        );
        $this->assertSame(0, $status, str_replace($dsn, '[dsn]', "PerfGateTest.php exited $status: $stdout$stderr"));
    }
}
