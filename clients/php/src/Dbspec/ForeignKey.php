<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** A named foreign key; actions are `restrict`, `cascade` or `set_null`. */
final class ForeignKey
{
    public const ACTIONS = ['restrict', 'cascade', 'set_null'];

    /**
     * @param list<string> $columns
     * @param list<string> $referencedColumns
     * @param list<string> $comments
     */
    public function __construct(
        public string $name,
        public array $columns,
        public string $table,
        public array $referencedColumns,
        public string $onDelete,
        public string $onUpdate,
        public array $comments = [],
    ) {
    }

    /** True when an action changes child rows: `cascade` or `set_null` on delete or update. */
    public function changesChildRows(): bool
    {
        return $this->onDelete !== 'restrict' || $this->onUpdate !== 'restrict';
    }
}
