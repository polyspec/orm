<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal */
interface ArrayValue
{
    /** @return array<string, mixed> */
    public function toArray(): array;
}
