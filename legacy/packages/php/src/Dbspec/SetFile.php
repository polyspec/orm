<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** One file of a read set (Dbspec::readSet): its joined path and its bytes, not yet checked. */
final readonly class SetFile
{
    public function __construct(public string $path, public string $bytes)
    {
    }
}
