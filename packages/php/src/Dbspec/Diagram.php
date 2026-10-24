<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

final class Diagram
{
    use NamedComments;

    /** @var list<Placement> */
    public array $placements = [];
    /** @var list<string> Comment lines before the closing brace. */
    public array $closingComments = [];
}
