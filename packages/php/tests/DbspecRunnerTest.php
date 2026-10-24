<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

require_once __DIR__ . '/dbspec-php-interface-program.php';

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\IntrospectResult;
use Polyspec\Orm\Dbspec\Unsupported;

require_once __DIR__ . '/dbspec_plan_cases.php';
require_once dirname(__DIR__) . '/testing/dbspec/apply/runner.php';
require_once dirname(__DIR__) . '/testing/dbspec/introspect/runner.php';

#[Small]
final class DbspecRunnerTest extends TestCase
{
    public function testApplyRunnerSelectsAndChainsItsTwoPlans(): void
    {
        $plans = \dbspec_apply_runner_plans(plan_vectors());

        self::assertCount(2, $plans);
        self::assertSame('create_from_empty', $plans[0]->name);
        self::assertSame('rename_table_and_column', $plans[1]->name);
        self::assertSame($plans[0]->to, $plans[1]->from);
    }

    public function testApplyRunnerRejectsMissingChainMember(): void
    {
        $vectors = plan_vectors();
        $vectors['cases'] = array_values(array_filter(
            $vectors['cases'],
            static fn(array $case): bool => $case['id'] === 'create-from-empty'
        ));

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('plans.json does not chain create-from-empty and rename-table-and-column');
        \dbspec_apply_runner_plans($vectors);
    }

    public function testIntrospectRunnerAppendsUnsupportedObjectsToCanonicalText(): void
    {
        $parsed = Dbspec::parse("dbspec 1 introspected\n", []);
        self::assertNotNull($parsed->document);
        $result = new IntrospectResult($parsed->document, [new Unsupported('view', '', 'audit_view', 'unsupported')]);

        self::assertSame(
            "dbspec 1 introspected\n! view\t\taudit_view\n",
            \dbspec_introspect_runner_output($result)
        );
    }

    public function testCompareRunnerUsesOneSharedOutputSequence(): void
    {
        $root = dirname(__DIR__, 3);
        $stressPath = tempnam(sys_get_temp_dir(), 'dbspec_compare_stress_');
        self::assertNotFalse($stressPath);
        try {
            self::assertSame(16, file_put_contents($stressPath, "dbspec 1 stress\n"));
            $inputs = [
                "$root/tests/dbspec/cases.json",
                $stressPath,
                "$root/tests/dbspec/ddl.json",
                "$root/tests/dbspec/plans.json",
                "$root/tests/dbspec/mermaid.json",
                "$root/tests/dbspec/syntax.json",
            ];
            $program = dbspec_php_interface_program($root, [
                'dbspec_write_comparison(Polyspec\\Orm\\Dbspec\\Dbspec::class, ' . var_export($inputs, true) . ');',
            ]);
            [$status, $output, $error] = coverageProcess([PHP_BINARY, '-r', $program], $root);
        } finally {
            unlink($stressPath);
        }

        self::assertSame(0, $status, $error);
        self::assertStringContainsString("stress\n", $output);
        self::assertStringContainsString('plans/cases/', $output);
        self::assertStringContainsString('positions/', $output);
        self::assertStringContainsString('syntax/', $output);
    }
}
