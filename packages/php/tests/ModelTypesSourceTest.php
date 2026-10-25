<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\PendingTime;
use Polyspec\Orm\Request;

final class ModelTypesSourceTest extends TestCase
{
    use ModelTypesWeakCallerCases;

    public function testRequestCanonicalizationKeepsItsStableShape(): void
    {
        $request = new Request('read', 'manifest');
        $request->params = ['unused', 1, 2, 3, 4, 5];
        $request->ir = ['where' => ['op' => 'in', 'ps' => [1, 2, 3, 4, 5]]];
        $request->canonicalize();
        self::assertSame(9, count($request->params));
        self::assertSame([1, 2, 3, 4, 5, 5, 5, 5], Request::padIn([1, 2, 3, 4, 5]));
        self::assertSame(9, $request->shape()['n_params']);
    }

    public function testPendingTimePreservesLoadedTextAndZone(): void
    {
        $zone = new DateTimeZone('UTC');
        $pending = new PendingTime('not parsed yet', $zone);
        self::assertSame('not parsed yet', $pending->text);
        self::assertSame($zone, $pending->zone);
    }
}
