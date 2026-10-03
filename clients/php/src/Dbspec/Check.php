<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** A named check; the expression is held in its canonical text. */
final class Check
{
    /** @param list<string> $comments */
    public function __construct(public string $name, public string $expression, public array $comments = [])
    {
    }
}
