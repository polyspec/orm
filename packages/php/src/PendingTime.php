<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal loaded date text, converted to DateTimeImmutable when the column is first read */
final class PendingTime
{
    public function __construct(public readonly string $text, public readonly \DateTimeZone $zone)
    {
    }
}
