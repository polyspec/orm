<?php

declare(strict_types=0);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Collection;
use Polyspec\Orm\Model;

function collectionWeakPut(Collection $collection, mixed $key, Model $model): void
{
    $collection->put($key, $model);
}
