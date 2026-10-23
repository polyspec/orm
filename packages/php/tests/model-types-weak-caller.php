<?php

declare(strict_types=0);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Func;
use Polyspec\Orm\Page;
use Polyspec\Orm\PendingTime;
use Polyspec\Orm\Request;

function modelTypesWeakRequest(mixed $kind, mixed $manifestHash): Request
{
    return new Request($kind, $manifestHash);
}

function modelTypesWeakFunc(mixed $name, mixed $column): Func
{
    return new Func($name, [], $column);
}

function modelTypesWeakPendingTime(mixed $text, DateTimeZone $zone): PendingTime
{
    return new PendingTime($text, $zone);
}

function modelTypesWeakPage(mixed $totalCount, mixed $totalPages, mixed $page, mixed $perPage): Page
{
    return new Page(new Collection(), $totalCount, $totalPages, $page, $perPage);
}
