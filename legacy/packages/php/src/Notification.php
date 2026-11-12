<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** One notification that a LISTEN subscription receives (docs/spec/dialects.md DIA-194). */
final class Notification
{
    public function __construct(
        public readonly string $channel,
        public readonly string $payload,
        public readonly int $pid,
    ) {
    }
}
