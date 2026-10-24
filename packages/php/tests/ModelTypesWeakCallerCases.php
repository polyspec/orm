<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

/** Shared weak-caller coercion cases for the PHP library and native extension. */
trait ModelTypesWeakCallerCases
{
    public function testWeakCallsMatchPhpScalarParameterRules(): void
    {
        self::assertSame('12', modelTypesWeakRequest(12, 34)->ir['kind']);
        self::assertSame('34', modelTypesWeakRequest(12, 34)->ir['manifest_hash']);
        self::assertTrue(modelTypesWeakFunc('f', 1)->column);
        self::assertSame('1', modelTypesWeakPendingTime(1, new \DateTimeZone('UTC'))->text);
        $page = modelTypesWeakPage(1.0, 2.0, 3.0, 4.0);
        self::assertSame([1, 2, 3, 4], [$page->totalCount, $page->totalPages, $page->page, $page->perPage]);

        foreach (
            [
            static fn () => modelTypesWeakRequest(null, 'hash'),
            static fn () => modelTypesWeakRequest('kind', null),
            static fn () => modelTypesWeakFunc('f', null),
            static fn () => modelTypesWeakPendingTime(null, new \DateTimeZone('UTC')),
            static fn () => modelTypesWeakPage(null, 1, 1, 1),
            static fn () => modelTypesWeakPage(1, null, 1, 1),
            static fn () => modelTypesWeakPage(1, 1, null, 1),
            static fn () => modelTypesWeakPage(1, 1, 1, null),
            ] as $call
        ) {
            try {
                $call();
                self::fail('weak caller accepted null for a non-null scalar parameter');
            } catch (\TypeError) {
                self::assertTrue(true);
            }
        }
    }
}
