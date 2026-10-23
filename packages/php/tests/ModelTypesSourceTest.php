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

require_once __DIR__ . '/model-types-weak-caller.php';

final class ModelTypesSourceTest extends TestCase
{
    public function testWeakCallsMatchPhpScalarParameterRules(): void
    {
        self::assertSame('12', modelTypesWeakRequest(12, 34)->ir['kind']);
        self::assertSame('34', modelTypesWeakRequest(12, 34)->ir['manifest_hash']);
        self::assertTrue(modelTypesWeakFunc('f', 1)->column);
        self::assertSame('1', modelTypesWeakPendingTime(1, new DateTimeZone('UTC'))->text);
        $page = modelTypesWeakPage(1.0, 2.0, 3.0, 4.0);
        self::assertSame([1, 2, 3, 4], [$page->totalCount, $page->totalPages, $page->page, $page->perPage]);

        foreach ([
            static fn () => modelTypesWeakRequest(null, 'hash'),
            static fn () => modelTypesWeakRequest('kind', null),
            static fn () => modelTypesWeakFunc('f', null),
            static fn () => modelTypesWeakPendingTime(null, new DateTimeZone('UTC')),
            static fn () => modelTypesWeakPage(null, 1, 1, 1),
            static fn () => modelTypesWeakPage(1, null, 1, 1),
            static fn () => modelTypesWeakPage(1, 1, null, 1),
            static fn () => modelTypesWeakPage(1, 1, 1, null),
        ] as $call) {
            try {
                $call();
                self::fail('weak caller accepted null for a non-null scalar parameter');
            } catch (\TypeError) {
                self::assertTrue(true);
            }
        }
    }

    public function testSourceHelpersKeepCanonicalizationAndValueSemantics(): void
    {
        $request = new Request('read', 'manifest');
        $request->params = ['unused', 1, 2, 3, 4, 5];
        $request->ir = ['where' => ['op' => 'in', 'ps' => [1, 2, 3, 4, 5]]];
        $request->canonicalize();
        self::assertSame(9, count($request->params));
        self::assertSame([1, 2, 3, 4, 5, 5, 5, 5], Request::padIn([1, 2, 3, 4, 5]));
        self::assertSame(9, $request->shape()['n_params']);

        self::assertSame(['kind' => 'sql-null'], json_decode(json_encode(StyledValue::sqlNull(), JSON_THROW_ON_ERROR), true));
        try {
            StyledValue::sqlNull()->payload();
            self::fail('SQL NULL has no value payload');
        } catch (OrmException $exception) {
            self::assertSame(Code::CODEC_DECODE, $exception->code_);
        }
        $func = new Func('sum', [2, 1], true);
        self::assertSame(['name' => 'sum', 'ps' => [5, 4]], $func->ir(static fn (int $arg): int => $arg + 3));
        $zone = new DateTimeZone('UTC');
        $pending = new PendingTime('not parsed yet', $zone);
        self::assertSame('not parsed yet', $pending->text);
        self::assertSame($zone, $pending->zone);
    }
}
