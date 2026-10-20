<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\Orm\Dbspec\CatalogRows;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\DocumentSet;
use Polyspec\Orm\Dbspec\Renderer;

final readonly class Stats
{
    public function __construct(
        public int $maxOpenConnections,
        public int $openConnections,
        public int $inUse,
        public int $idle
    )
    {
    }
}
