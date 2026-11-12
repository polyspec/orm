<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * @template TColumn
 * @internal
 */
trait NamedColumns
{
    public string $name;
    /** @var list<TColumn> */
    public array $columns;
    /** @var list<string> */
    public array $comments;

    /**
     * @param list<TColumn> $columns
     * @param list<string> $comments
     */
    public function __construct(string $name, array $columns, array $comments = [])
    {
        $this->initializeNamedColumns($name, $columns, $comments);
    }

    /**
     * @param list<TColumn> $columns
     * @param list<string> $comments
     */
    private function initializeNamedColumns(string $name, array $columns, array $comments): void
    {
        $this->name = $name;
        $this->columns = $columns;
        $this->comments = $comments;
    }
}
