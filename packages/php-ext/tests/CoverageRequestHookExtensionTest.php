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

    // Requirements: INT-78.
    public function testWithoutHook(): void
    {
        parent::testWithoutHook();
    }

    // Requirements: INT-78, PRT-2.
    public function testReadFilter(): void
    {
        parent::testReadFilter();
    }

    // Requirements: INT-78.
    public function testRelationScope(): void
    {
        parent::testRelationScope();
    }

    // Requirements: PRT-65.
    public function testInvalidParam(): void
    {
        parent::testInvalidParam();
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
}
