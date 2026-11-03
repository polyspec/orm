<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use RuntimeException;
use ReflectionMethod;
use Polyspec\Orm\Model;

#[Large]
abstract class PerformanceGateCoverageCase extends TestCase
{
    protected const DRIVER = '';
    protected const NATIVE_EXTENSION = false;

    public function testHotPathGate(): void
    {
        $database = static::DRIVER;
        $name = 'BENCH_' . strtoupper($database) . '_DSN';
        $dsn = getenv($name);
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException("$name is required; run make orm-test-servers, which starts the databases and writes it");
        }
        if (static::NATIVE_EXTENSION) {
            Assert::assertTrue((new ReflectionMethod(Model::class, 'gets'))->isInternal());
            $extension = getenv('POLYSPEC_ORM_EXTENSION');
            if (!is_string($extension) || $extension === '' || !is_file($extension)) {
                throw new RuntimeException(
                    'POLYSPEC_ORM_EXTENSION is required; run this owner through the PHP extension coverage runner',
                );
            }
        } else {
            $extension = null;
        }

        $root = dirname(__DIR__, 3);
        $phpunit = $root . '/vendor-php/bin/phpunit';
        $config = dirname(__DIR__) . (static::NATIVE_EXTENSION ? '/../php-ext/phpunit.xml.dist' : '/phpunit.xml.dist');
        $test = __DIR__ . '/PerfGateTest.php';
        $command = [PHP_BINARY];
        if ($extension !== null) {
            array_push($command, '-d', "extension=$extension");
        }
        array_push($command, $phpunit, '--configuration', $config, $test);
        $env = getenv();
        if (!is_array($env)) {
            throw new RuntimeException('cannot read the environment for the performance coverage case');
        }
        // Keep the declared empty list present in the child environment.
        $env['ORM_PERF_REFUSED_LOADED'] = ',';
        $env['ORM_PERF_DATABASE'] = $database;
        if (static::NATIVE_EXTENSION) {
            $env['ORM_PHP_MODE'] = 'extension';
        }
        [$status, $stdout, $stderr] = coverageProcess($command, $root, $env);
        $details = str_replace($dsn, '[dsn]', "$stdout$stderr");
        Assert::assertSame(0, $status, "PerfGateTest.php exited $status: $details");
        Assert::assertStringContainsString('reference=not-recorded', $stderr);
        $runtime = static::NATIVE_EXTENSION ? 'php-extension' : 'php';
        foreach (['pk', 'list100'] as $workload) {
            Assert::assertStringContainsString("PERF hot_path_gate $runtime $database $workload:", $stderr);
        }
        fwrite(STDERR, $stderr);
    }
}
