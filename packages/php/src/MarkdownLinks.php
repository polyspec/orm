<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal The join and relation rows of one markdown answer row. Kept in the row's last cell. */
final class MarkdownLinks
{
    /** @var array<string, list<mixed>|null> join name => its position row, or null if none */
    public array $joins = [];
    /** @var array<string, list<list<mixed>>> relation name => its position rows */
    public array $rels = [];
}
