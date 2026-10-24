<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** A named foreign key; actions are `restrict`, `cascade` or `set_null`. */
final class ForeignKey
{
    public const ACTIONS = ['restrict', 'cascade', 'set_null'];

    /** @use NamedColumns<string> */
    use NamedColumns;

    /**
     * @param list<string> $columns
     * @param list<string> $referencedColumns
     * @param list<string> $comments
     */
    public function __construct(
        string $name,
        array $columns,
        public string $table,
        public array $referencedColumns,
        public string $onDelete,
        public string $onUpdate,
        array $comments = [],
    ) {
        $this->initializeNamedColumns($name, $columns, $comments);
    }

    /** True when an action changes child rows: `cascade` or `set_null` on delete or update. */
    public function changesChildRows(): bool
    {
        return in_array($this->onDelete, ['cascade', 'set_null'], true)
            || in_array($this->onUpdate, ['cascade', 'set_null'], true);
    }
}
