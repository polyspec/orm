<?php

declare(strict_types=1);

namespace Polyspec\Orm;

final readonly class AesRotationStatus
{
    /** @param array<int, int> $versions */
    public function __construct(public int $current, public int $total, public int $pending, public array $versions)
    {
    }
}
