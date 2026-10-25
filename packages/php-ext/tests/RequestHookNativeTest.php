<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

#[Medium]
final class RequestHookNativeTest extends TestCase
{
    // Requirements: INT-78.
    public function testWithoutHook(): void
    {
        $this->runNativeCase('without_hook');
    }

    // Requirements: INT-78, PRT-2.
    public function testReadFilter(): void
    {
        $this->runNativeCase('read_filter');
    }

    // Requirements: PRT-4, PRT-5, PRT-41.
    public function testInsertAssign(): void
    {
        $this->runNativeCase('insert_assign');
    }

    // Requirements: INT-78, PRT-4, PRT-6.
    public function testUpsertScope(): void
    {
        $this->runNativeCase('upsert_scope');
    }

    // Requirements: CFG-21, INT-36, INT-37, PLN-16.
    public function testLoadedRowWrites(): void
    {
        $this->runNativeCase('loaded_row_writes');
    }

    // Requirements: PRT-65.
    public function testInvalidParam(): void
    {
        $this->runNativeCase('invalid_param');
    }

    // Requirements: DIA-161.
    public function testRestoreKey(): void
    {
        $this->runNativeCase('restore_key');
    }

    // Requirements: DIA-161, INT-38.
    public function testRestoreCondition(): void
    {
        $this->runNativeCase('restore_condition');
    }

    // Requirements: DIA-161.
    public function testRestoreNoKey(): void
    {
        $this->runNativeCase('restore_no_key');
    }

    public function testSameHandleChildUsesNativeTerminalAndRunsOneHook(): void
    {
        $this->runNativeCase('same_handle_child_hook_once');
    }

    // Requirements: DIA-161.
    public function testRestoreRewrittenKey(): void
    {
        $this->runNativeCase('restore_rewritten_key');
    }

    public function testRestoreHookSetKey(): void
    {
        $this->runNativeCase('restore_hook_set_key');
    }

    public function testRestoreRewrittenKeySetScope(): void
    {
        $this->runNativeCase('restore_rewritten_key_set_scope');
    }

    private function runNativeCase(string $case): void
    {
        $methods = [
            [Db::class, 'withRequestHook'],
            [Model::class, 'get'],
            [Model::class, 'matchValues'],
        ];
        foreach ($methods as [$class, $method]) {
            self::assertTrue(
                (new ReflectionMethod($class, $method))->isInternal(),
                "$class::$method must run through the native extension"
            );
        }

        require_once dirname(__DIR__, 2) . '/php/gen/bootstrap.php';
        require_once dirname(__DIR__, 2) . '/php/tests/generated_classes.php';
        require_once dirname(__DIR__, 2) . '/php/tests/request_hook_cases.php';
        $work = sys_get_temp_dir() . '/orm-ext-request-hook-' . getmypid() . '-' . $case;
        if (!mkdir($work, 0o700, true)) {
            self::fail("cannot create $work");
        }
        try {
            runRequestHookCase($case, "sqlite://$work/case.sqlite");
        } finally {
            exec('rm -rf ' . escapeshellarg($work), $output, $status);
            self::assertSame(0, $status, "cannot remove $work");
        }
    }
}
