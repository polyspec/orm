<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** One page of the group rows of getsCount read one group past its end, with no total (INT-164). */
final readonly class GroupLookaheadPage
{
    public function __construct(
        public GroupRows $items,
        public int $page,
        public int $perPage,
        public bool $hasNext,
    ) {
    }
}
