<?php
declare(strict_types=1);

namespace Orm;

/** A JSON object whose keys are written in sorted order, like a Go map. */
final class GoMap
{
    /** @param array<string, mixed> $items */
    public function __construct(public array $items = []) {}
}
