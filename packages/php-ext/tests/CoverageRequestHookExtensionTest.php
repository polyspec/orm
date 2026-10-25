<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use ReflectionClass;
use ReflectionMethod;

#[Medium]
final class CoverageRequestHookExtensionTest extends CoverageRequestHookTest
{
    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    public function testNativeMethodsAreInternal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'withRequestHook'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'get'))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'matchValues'))->isInternal());
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
        parent::testWithoutHook();
    }

    // Requirements: INT-78.
    public function testRelationScope(): void
    {
        parent::testRelationScope();
    }

    // The insert assignment case of the PHP library, run with the extension loaded.
    // Requirements: PRT-4, PRT-5, PRT-41.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- the parity binding names this exact test symbol.
    public function testInsertAssign(): void
    {
        parent::testInsertAssign();
    }

    // Requirements: CFG-21, INT-36, INT-37, PLN-16.
    public function testLoadedRowWrites(): void
    {
        parent::testLoadedRowWrites();
    }

    // Requirements: PRT-65.
    public function testInvalidParam(): void
    {
        parent::testInvalidParam();
    }

    // Requirements: DIA-161.
    public function testRestoreKey(): void
    {
        parent::testRestoreKey();
    }

    // Requirements: DIA-161, INT-38.
    public function testRestoreCondition(): void
    {
        parent::testRestoreCondition();
    }

    // Requirements: DIA-161.
    public function testRestoreNoKey(): void
    {
        parent::testRestoreNoKey();
    }

    // Requirements: DIA-161.
    public function testRestoreRewrittenKey(): void
    {
        parent::testRestoreRewrittenKey();
    }

    // Requirements: DIA-161.
    public function testRestoreHookSetKey(): void
    {
        parent::testRestoreHookSetKey();
    }

    // Requirements: DIA-161.
    public function testRestoreRewrittenKeySetScope(): void
    {
        parent::testRestoreRewrittenKeySetScope();
    }

    // Requirements: INT-78, PRT-4, PRT-6.
    public function testUpsertScope(): void
    {
        parent::testUpsertScope();
    }
}
