<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Collection;
use Polyspec\Orm\GroupRows;

#[Small]
class GroupRowsTest extends TestCase
{
    // Requirements: INT-68, PRT-69, INT-1, INT-90. The imported cases assert the public group-row output values.
    use GroupRowsCases;

    // The declared form of toArray is a surface of PHP, which no recipe reads (FCV-2). Requirements: INT-71.
    public function testOwner(): void
    {
        foreach ([Collection::class, GroupRows::class] as $class) {
            $method = new \ReflectionMethod($class, 'toArray');
            self::assertTrue($method->isPublic(), "$class::toArray is not public");
            self::assertSame([], $method->getParameters(), "$class::toArray accepts arguments");
            self::assertSame('array', $method->getReturnType()?->getName(), "$class::toArray return type changed");
            self::assertSame(
                $class,
                $method->getDeclaringClass()->getName(),
                "$class::toArray is not declared on the class"
            );
        }
    }
}
