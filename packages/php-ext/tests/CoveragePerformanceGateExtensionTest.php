<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Model;
use ReflectionMethod;
use RuntimeException;

#[Large]
final class CoveragePerformanceGateExtensionTest extends TestCase
{
    public function testHotPathGate(): void
    {
        Assert::assertTrue((new ReflectionMethod(Model::class, 'gets'))->isInternal());
        $extension = getenv('POLYSPEC_ORM_EXTENSION');
        if (!is_string($extension) || $extension === '' || !is_file($extension)) {
            throw new RuntimeException(
                'POLYSPEC_ORM_EXTENSION is required; run this owner through the PHP extension coverage runner'
            );
        }
        $root = dirname(__DIR__, 3);
        $phpunit = $root . '/vendor-php/bin/phpunit';
        $config = dirname(__DIR__) . '/phpunit.xml.dist';
        $test = dirname(__DIR__, 2) . '/php/tests/PerfGateTest.php';
        $command = [
            PHP_BINARY,
            '-d',
            "extension=$extension",
            $phpunit,
            '--configuration',
            $config,
            $test,
        ];
        $env = getenv();
        if (!is_array($env)) {
            throw new RuntimeException('cannot read the environment for the extension performance case');
        }
        $env['ORM_PHP_MODE'] = 'extension';
        $env['ORM_PERF_REFUSED_LOADED'] = '';
        [$status, $stdout, $stderr] = coverageProcess($command, $root, $env);
        $dsn = getenv('ORM_BENCH_MYSQL_DSN');
        $details = is_string($dsn) && $dsn !== ''
            ? str_replace($dsn, '[dsn]', "$stdout$stderr")
            : "$stdout$stderr";
        $this->assertSame(
            0,
            $status,
            "native extension PerfGateTest.php exited $status: $details"
        );
        $this->assertStringContainsString('reference not-recorded', $stderr);
        foreach (['pk', 'list100'] as $workload) {
            $this->assertStringContainsString("perf_gate $workload:", $stderr);
        }
        fwrite(STDERR, $stderr);
    }
}
