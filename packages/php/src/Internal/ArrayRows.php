<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

/** @internal */
trait ArrayRows
{
    /** @return list<array<string, mixed>> */
    public function toArray(): array
    {
        return ArrayValueRows::rows($this->all());
    }
}
