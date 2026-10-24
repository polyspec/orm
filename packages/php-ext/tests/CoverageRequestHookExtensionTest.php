<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use ReflectionClass;
use ReflectionMethod;

require_once dirname(__DIR__, 2) . '/php/tests/CoverageRequestHookTest.php';

#[Medium]
final class CoverageRequestHookExtensionTest extends CoverageRequestHookTest
{
    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    public function test_native_methods_are_internal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'withRequestHook'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'get'))->isInternal());
    }

    // Requirements: INT-78.
    public function testReadsParams(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'withRequestHook'))->isInternal());
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        $path = tempnam(sys_get_temp_dir(), 'orm-php-ext-request-hook-reads-params-');
        if (!is_string($path)) {
            throw new \RuntimeException('cannot create the request hook SQLite database file');
        }
        try {
            readsParamsCase('sqlite://' . $path);
        } finally {
            unlink($path);
        }
    }

    // Requirements: INT-78, PRT-2.
    public function testSameHandleChildHookOnce(): void
    {
        parent::testSameHandleChildHookOnce();
    }

    // Requirements: INT-78.
    public function testWithoutHook(): void
    {
        parent::test_without_hook();
    }

    // Requirements: CFG-21, INT-36, INT-37, PLN-16.
    public function testLoadedRowWrites(): void
    {
        parent::test_loaded_row_writes();
    }

    // Requirements: PRT-65.
    public function testInvalidParam(): void
    {
        parent::test_invalid_param();
    }

    // Requirements: DIA-161.
    public function testRestoreKey(): void
    {
        parent::test_restore_key();
    }

    // Requirements: DIA-161, INT-38.
    public function testRestoreCondition(): void
    {
        parent::test_restore_condition();
    }

    // Requirements: DIA-161.
    public function testRestoreNoKey(): void
    {
        parent::test_restore_no_key();
    }

    // Requirements: DIA-161.
    public function testRestoreRewrittenKey(): void
    {
        parent::test_restore_rewritten_key();
    }

    // Requirements: DIA-161.
    public function testRestoreHookSetKey(): void
    {
        parent::test_restore_hook_set_key();
    }

    // Requirements: DIA-161.
    public function testRestoreRewrittenKeySetScope(): void
    {
        parent::test_restore_rewritten_key_set_scope();
    }

    // Requirements: INT-78, PRT-4, PRT-6.
    public function testUpsertScope(): void
    {
        parent::testUpsertScope();
    }
}
