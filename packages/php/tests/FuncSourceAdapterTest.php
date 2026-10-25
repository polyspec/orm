<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Func;

final class FuncSourceAdapterTest extends TestCase
{
    public function testCallbackLoweringKeepsArgumentOrderAndShape(): void
    {
        $func = new Func('sum', [2, 1], true);
        self::assertSame(['name' => 'sum', 'ps' => [5, 4]], $func->ir(static fn (int $arg): int => $arg + 3));
    }
}
