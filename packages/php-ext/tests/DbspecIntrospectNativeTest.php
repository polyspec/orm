<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;
use ReflectionMethod;

// Native under FCV-2: that the extension's method takes the place of the library's exists only in this runtime.
#[Small]
final class DbspecIntrospectNativeTest extends TestCase
{
    // Requirements: DIA-133b.
    public function testIntrospectIsTheMethodOfTheExtension(): void
    {
        self::assertTrue((new ReflectionMethod(Dbspec::class, 'introspect'))->isInternal());
    }
}
