<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Engine;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\Model;
use Polyspec\Orm\Planner;
use Polyspec\Orm\Tests\Model\Author;
use ReflectionClass;

#[Medium]
// Requirements: INT-31.
final class GroupRowsDbNativeTest extends TestCase
{
    use DatabaseTestAssertions;
    // Requirements: INT-31. The imported database case checks grouped values and counts on each dialect.
    use GroupRowsDbCases;

    public static function setUpBeforeClass(): void
    {
        foreach ([Engine::class, Model::class, Planner::class, GroupRow::class, GroupRows::class] as $class) {
            Assert::assertTrue((new ReflectionClass($class))->isInternal(), "$class must use the native extension");
        }
        Assert::assertTrue(is_subclass_of(Author::class, Model::class));
    }
}
