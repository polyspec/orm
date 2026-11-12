<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** @internal */
trait NamedComments
{
    /** @param list<string> $comments */
    public function __construct(public string $name, public array $comments = [])
    {
    }
}
