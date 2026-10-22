<?php

// The hot-path gate refuses a PHP that loads a debugger or coverage driver.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class PerfExtensionsTest extends TestCase
{
    public function testRefused(): void
    {
        foreach (
            [
            [[], []],
            [['xdebug'], ['xdebug']],
            [['pcov'], ['pcov']],
            [['xdebug', 'pcov', 'apcu'], ['xdebug', 'pcov']],
            [['apcu', 'opcache'], []],
            ] as [$loaded, $refused]
        ) {
            $got = perfGateRefusedExtensions(fn (string $name): bool => in_array($name, $loaded, true));
            self::assertSame($refused, $got, 'loaded ' . json_encode($loaded));
        }
    }

    public function testThisPHP(): void
    {
        self::assertSame(declaredRefusedExtensions(), loadedRefusedExtensions(), 'the declared refused extensions differ from the loaded ones');
    }
}
