<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * A parsed plan document (docs/plans.md "Plan document"). `from` is null for
 * a plan that starts from an empty database; `to` is the schemaHash of the
 * target schema text.
 */
final readonly class Plan
{
    /**
     * @param list<TableRename> $renameTables
     * @param list<ColumnRename> $renameColumns
     * @param list<string> $dropTables
     * @param list<ColumnName> $dropColumns
     */
    public function __construct(
        public string $name,
        public ?string $from,
        public array $renameTables,
        public array $renameColumns,
        public array $dropTables,
        public array $dropColumns,
        public Document $schema,
        public string $to,
    ) {
    }
}
