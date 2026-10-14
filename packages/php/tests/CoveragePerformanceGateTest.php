<?php
declare(strict_types=1);
// performance_gate feature coverage: packages/php/tests/PerfGateTest.php를 자식
// PHPUnit process로 실행하고 종료 코드 0일 때만 통과한다. gate의 출력은 이 test의 출력에
// 넣지 않고, 실패하면 오류에 담는다. ORM_BENCH_MYSQL_DSN은 seed된 공유 bench
// database이며 gate는 읽기만 한다.

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
            throw new RuntimeException('ORM_BENCH_MYSQL_DSN is required; run it through make check or make run-databases TARGETS=<target>, which create the bench database of the run');
        }
        $package = dirname(__DIR__);
        [$status, $stdout, $stderr] = coverageProcess(
            [PHP_BINARY, dirname(__DIR__, 3) . '/vendor-php/bin/phpunit', '--configuration', "$package/phpunit.xml.dist", __DIR__ . '/PerfGateTest.php'],
            dirname(__DIR__, 3),
        );
        $this->assertSame(0, $status, str_replace($dsn, '[dsn]', "PerfGateTest.php exited $status: $stdout$stderr"));
    }
}
