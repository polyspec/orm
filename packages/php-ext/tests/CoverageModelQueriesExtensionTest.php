<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Collection;
use Polyspec\Orm\Model;
use Polyspec\Orm\Tests\CoverageModelQueriesCase;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;

#[Medium]
final class CoverageModelQueriesExtensionTest extends TestCase
{
    // Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30, INT-32, INT-33, PLN-11, PLN-25.
    public function testModelQueryRows(): void
    {
        Assert::assertTrue((new ReflectionClass(Model::class))->isInternal());
        Assert::assertTrue((new ReflectionMethod(Model::class, 'gets'))->isInternal());
        Assert::assertTrue((new ReflectionClass(Collection::class))->isInternal());
        require_once dirname(__DIR__, 2) . '/php/tests/CoverageModelQueriesCase.php';
        coverageRunDatabaseItems(__FILE__, static function (\Polyspec\Orm\Db $db): void {
            CoverageModelQueriesCase::run($db);
        });
    }
}
