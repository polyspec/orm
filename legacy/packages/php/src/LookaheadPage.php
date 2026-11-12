<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * One page of models read one row past its end, with no total (INT-164).
 *
 * @template TModel of Model
 */
final readonly class LookaheadPage
{
    /** @param Collection<TModel> $items */
    public function __construct(
        public Collection $items,
        public int $page,
        public int $perPage,
        public bool $hasNext,
    ) {
    }
}
