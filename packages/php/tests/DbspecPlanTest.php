<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The native plan checks beside tests/dbspec/plan-cases.json (its cases run as the recipe in DbspecPlanCasesTest): the
// comparison harness of the PHP compare, and the unknown dialect rule (DBS-174), which no public call accepts.

use InvalidArgumentException;
use PDO;
use RuntimeException;
use Polyspec\Orm\Dbspec\Change;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Document;
use Polyspec\Orm\Dbspec\Plan;
use Polyspec\Orm\Dbspec\PlanStep;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/** @param ?list<string> $lines */
function plan_source(string $id, ?array $lines): ?Document
{
    if ($lines === null) {
        return null;
    }
    $result = Dbspec::parse(dbspec_plan_text($lines), []);
    return $result->document ?? throw new RuntimeException(
        "$id: source diagnostics " . plan_diagnostics($result->diagnostics)
    );
}

function plan_of(string $id, array $lines): Plan
{
    $result = Dbspec::parsePlan(dbspec_plan_text($lines));
    return $result->plan ?? throw new RuntimeException(
        "$id: plan diagnostics " . plan_diagnostics($result->diagnostics)
    );
}

#[Small]
class DbspecPlanTest extends TestCase
{
    public function testComparisonHarnessParsesPlanVectorsAndWritesDiagnostics(): void
    {
        $root = dirname(__DIR__, 3);
        $plans = ['cases' => [plan_vectors()['cases'][0]]];
        $program = dbspec_php_interface_program($root, [
            '$plans = ' . var_export($plans, true) . ';',
            'ob_start();',
            '$plan = dbspec_parse_plan(Polyspec\\Orm\\Dbspec\\Dbspec::class, $plans[\'cases\'][0][\'plan\']);',
            '$validOutput = ob_get_clean();',
            'ob_start();',
            '$rejected = dbspec_parse_plan(Polyspec\\Orm\\Dbspec\\Dbspec::class, [\'not a plan\']);',
            '$invalidOutput = ob_get_clean();',
            'ob_start();',
            '$casePlan = dbspec_case_plan(Polyspec\\Orm\\Dbspec\\Dbspec::class, $plans[\'cases\'][0]);',
            '$caseOutput = ob_get_clean();',
            'echo json_encode([$plan?->name, $validOutput, $rejected === null, $invalidOutput, '
                . '$casePlan !== false, $casePlan[1]->name ?? null, $caseOutput], JSON_THROW_ON_ERROR);',
        ]);
        [$status, $stdout, $stderr] = coverageProcess([PHP_BINARY, '-r', $program], $root);
        self::assertSame(0, $status, $stderr);
        $result = json_decode($stdout, true, 512, JSON_THROW_ON_ERROR);
        self::assertNotSame('', $result[0], 'valid plan is returned');
        self::assertSame('', $result[1], 'valid plan has no diagnostic output');
        self::assertTrue($result[2], 'invalid plan is rejected');
        self::assertStringStartsWith('! plan ', $result[3], 'invalid plan diagnostics are written');
        self::assertTrue($result[4], 'case plan input is returned');
        self::assertSame($result[0], $result[5], 'case helper returns the same plan');
        self::assertSame('', $result[6], 'valid case input has no diagnostic output');
    }

    // Requirements: DBS-174.
    public function testUnknownDialect(): void
    {
        $plan = plan_of('plan/unknown-dialect', plan_vectors()['cases'][0]['plan']);
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('oracle');
        Dbspec::planSteps(null, $plan, 'oracle');
    }

    public function testFreshConnectionRulesCoverEveryDatabase(): void
    {
        self::assertSame([
            'mysql' => ["SET time_zone = '+00:00'"],
            'postgres' => ["SET TimeZone = 'UTC'"],
            'sqlite' => ['PRAGMA foreign_keys = ON'],
        ], dbspec_connection_rules());
    }

    public function testDbspecDsnsPreserveMissingVariableErrors(): void
    {
        $names = ['mysql' => 'ORM_TEST_MYSQL_DSN', 'postgres' => 'ORM_TEST_POSTGRES_DSN'];
        $old = [];
        foreach ($names as $name) {
            $old[$name] = getenv($name);
        }
        try {
            foreach ($names as $name) {
                putenv($name);
            }
            try {
                dbspec_dsns($names, 'both database DSNs are required');
                self::fail('missing DSNs were accepted');
            } catch (RuntimeException $error) {
                self::assertSame('both database DSNs are required', $error->getMessage());
            }
            putenv('ORM_TEST_MYSQL_DSN=mysql://test');
            putenv('ORM_TEST_POSTGRES_DSN=postgres://test');
            self::assertSame(
                ['mysql' => 'mysql://test', 'postgres' => 'postgres://test'],
                dbspec_dsns($names, 'both database DSNs are required')
            );
            putenv('ORM_TEST_POSTGRES_DSN');
            try {
                dbspec_dsns($names);
                self::fail('the missing individual DSN was accepted');
            } catch (RuntimeException $error) {
                self::assertSame(
                    'ORM_TEST_POSTGRES_DSN is not set; run the test through make orm-test-servers or its make target',
                    $error->getMessage()
                );
            }
        } finally {
            foreach ($old as $name => $value) {
                if ($value === false) {
                    putenv($name);
                } else {
                    putenv("$name=$value");
                }
            }
        }
        foreach ($old as $name => $value) {
            self::assertSame($value, getenv($name));
        }
    }

    public function testDbspecQueryValuesPreserveEachNullPolicy(): void
    {
        $pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        self::assertSame('7', dbspec_value($pdo, 'SELECT 7'));
        self::assertSame('text', dbspec_value($pdo, "SELECT 'text'"));
        self::assertSame('NULL', dbspec_value($pdo, 'SELECT NULL', true));
        try {
            dbspec_value($pdo, 'SELECT NULL');
            self::fail('the apply fixture accepted SQL NULL');
        } catch (RuntimeException $error) {
            self::assertSame('SELECT NULL: value of type null has no text form here', $error->getMessage());
        }
        try {
            dbspec_value($pdo, 'SELECT 1.5', true);
            self::fail('a floating point value was accepted as text');
        } catch (RuntimeException $error) {
            self::assertSame('SELECT 1.5: value of type float has no text form here', $error->getMessage());
        }
    }

    public function testSqliteTestDatabaseCleanupRemovesEverySidecar(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'dbspec-cleanup-');
        if ($path === false) {
            self::fail('could not create the test database fixture');
        }
        $files = array_map(static fn(string $suffix): string => $path . $suffix, ['', '-journal', '-wal', '-shm']);
        try {
            foreach ($files as $file) {
                self::assertNotFalse(file_put_contents($file, 'fixture'), "$file fixture");
            }
            dbspec_remove_sqlite_files($path);
            foreach ($files as $file) {
                self::assertFileDoesNotExist($file);
            }
        } finally {
            foreach ($files as $file) {
                if (file_exists($file)) {
                    unlink($file);
                }
            }
        }
    }
}
