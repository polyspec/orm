<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Large;
use Polyspec\Orm\Model;
use ReflectionMethod;

/** Executes the shared markdown corpus with the extension's native Model methods loaded. */
#[Large]
final class MarkdownConformanceNativeTest extends \Polyspec\Orm\Tests\MarkdownConformanceTest
{
    /** @param array{id: string, expect: mixed} $case */
    #[DataProvider('cases')]
    public function testMarkdownConformance(array $case): void
    {
        parent::testMarkdownConformance($case);
    }

    public function testGeneratedModelOperationsAreNativeExtensionMethods(): void
    {
        self::assertTrue(extension_loaded('polyspec_orm'));
        foreach (
            [
                'get', 'gets', 'getsCount', 'getCount', 'getSum', 'getAvg',
                'getsPage', 'create', 'creates', 'update', 'delete', 'restore',
            ] as $method
        ) {
            self::assertTrue((new ReflectionMethod(Model::class, $method))->isInternal(), $method);
        }
    }
}
