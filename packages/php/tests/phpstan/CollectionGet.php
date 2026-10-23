<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests\Phpstan;

use Polyspec\Orm\Collection;
use Polyspec\Orm\Model;

/**
 * @template T of Model
 * @param Collection<T> $rows
 * @return T|null
 */
function modelAt(Collection $rows, int $key): ?Model
{
    return $rows->get($key);
}

/**
 * @template T of Model
 * @param Collection<T> $rows
 * @return T|null
 */
function firstModel(Collection $rows): ?Model
{
    return $rows->first();
}
