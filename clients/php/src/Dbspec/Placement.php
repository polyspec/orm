<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** `<table> at <x> <y>` in a diagram. */
final class Placement
{
    /** @param list<string> $comments */
    public function __construct(public string $table, public int $x, public int $y, public array $comments = [])
    {
    }
}
