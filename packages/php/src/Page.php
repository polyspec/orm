<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** One page of rows. */
final readonly class Page
{
    public function __construct(
        public Collection $items,
        public int $totalCount,
        public int $totalPages,
        public int $page,
        public int $perPage,
    ) {}
}
