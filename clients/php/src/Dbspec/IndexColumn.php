<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

final readonly class IndexColumn
{
    public function __construct(public string $name, public bool $descending)
    {
    }
}
