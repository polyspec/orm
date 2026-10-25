<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Func;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Page;
use Polyspec\Orm\PendingTime;
use Polyspec\Orm\Request;
use Polyspec\Orm\StyledValue;

final class ModelTypesSourceTest extends TestCase
{
    use ModelTypesWeakCallerCases;

    public function testSourceHelpersKeepCanonicalizationAndValueSemantics(): void
    {
        $request = new Request('read', 'manifest');
        $request->params = ['unused', 1, 2, 3, 4, 5];
        $request->ir = ['where' => ['op' => 'in', 'ps' => [1, 2, 3, 4, 5]]];
        $request->canonicalize();
        self::assertSame(9, count($request->params));
        self::assertSame([1, 2, 3, 4, 5, 5, 5, 5], Request::padIn([1, 2, 3, 4, 5]));
        self::assertSame(9, $request->shape()['n_params']);

        self::assertSame(
            ['kind' => 'sql-null'],
            json_decode(json_encode(StyledValue::sqlNull(), JSON_THROW_ON_ERROR), true),
        );
        try {
            StyledValue::sqlNull()->payload();
            self::fail('SQL NULL has no value payload');
        } catch (OrmException $exception) {
            self::assertSame(Code::CODEC_DECODE, $exception->code_);
        }
        $zone = new DateTimeZone('UTC');
        $pending = new PendingTime('not parsed yet', $zone);
        self::assertSame('not parsed yet', $pending->text);
        self::assertSame($zone, $pending->zone);
    }

    public function testPublicFuncIrKeepsArgumentOrderAndShape(): void
    {
        $func = new Func('sum', [2, 1], true);
        self::assertSame(['name' => 'sum', 'ps' => [5, 4]], $func->ir(static fn (int $arg): int => $arg + 3));
    }
}
