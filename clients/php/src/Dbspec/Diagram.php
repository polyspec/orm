<?php
declare(strict_types=1);

namespace Orm\Dbspec;

final class Diagram
{
    /** @var list<Placement> */
    public array $placements = [];
    /** @var list<string> Comment lines before the closing brace. */
    public array $closingComments = [];

    /** @param list<string> $comments */
    public function __construct(public string $name, public array $comments = [])
    {
    }
}
