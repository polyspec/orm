<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * One setting line. The kind is one of KINDS, in canonical order; the
 * arguments are the names the line lists: `audit` holds the history table,
 * the audit column, the audit record table, and the action and previous
 * columns in that order. `store` holds its kind, the foreign key of `block`,
 * the shape of `document` and `block` (STORE_ARGUMENTS counts them), and then
 * the column and the period of its `shard` clause when it has one.
 *
 * The audit's exclude and include are lists of columns, other than the unrecorded columns and the audit
 * columns, or null if there are no lists. A parsed setting has only one of the two.
 * (docs/dbspec.md "Audit").
 */
final class Setting
{
    public const KINDS = ['entity', 'updated', 'soft_delete', 'select_explicit', 'codec', 'aes_version', 'blind_index', 'navigation', 'markdown', 'store', 'key_prefix', 'title', 'body', 'order', 'checkbox', 'state_machine', 'immutable', 'audit'];
    public const CODEC_STAGES = ['ordered_json', 'aes', 'hex', 'gz', 'base64', 'serialize', 'yaml', 'ip'];
    /** The number of arguments before the shard clause for each store kind (including the kind). */
    public const STORE_ARGUMENTS = ['files' => 1, 'document' => 2, 'block' => 3];

    /**
     * @param list<string> $arguments
     * @param list<string> $comments
     * @param list<string>|null $exclude
     * @param list<string>|null $include
     * @param 'transition'|'terminal'|'initial'|'history'|'limit'|null $form The line form of a state_machine setting
     * @param list<string>|null $requires The `require (...)` columns of a transition or terminal line
     */
    public function __construct(
        public string $kind,
        public array $arguments,
        public array $comments = [],
        public ?array $exclude = null,
        public ?array $include = null,
        public ?string $form = null,
        public ?array $requires = null,
    ) {
    }

    /**
     * Tells whether the audit trigger copies the column. An audit column is always copied, and a column in the exclude list
     * column is never copied; if there is an include list, only that column is copied.
     */
    public function records(string $column): bool
    {
        if ($column === $this->arguments[1]) {
            return true;
        }
        if ($this->exclude !== null) {
            return !in_array($column, $this->exclude, true);
        }
        if ($this->include !== null) {
            return in_array($column, $this->include, true);
        }
        return true;
    }

    /**
     * Returns, in column order, the table's columns that the audit trigger does not copy, which the schema text
     * writes as a list.
     *
     * @return list<string>
     */
    public function excluded(Table $table): array
    {
        $out = [];
        foreach ($table->columns as $column) {
            if (!$this->records($column->name)) {
                $out[] = $column->name;
            }
        }
        return $out;
    }

    /**
     * The audit setting line. If the list is empty, it is written without a list; otherwise the list keyword and its columns are written.
     *
     * @param list<string>|null $columns
     */
    public function auditLine(string $list, ?array $columns): string
    {
        [$history, $column, $references, $action, $previous] = $this->arguments;
        $line = "audit into $history column $column references $references action $action previous $previous";
        if (count($this->arguments) === 8) {
            $line .= " tables {$this->arguments[5]} ({$this->arguments[6]}, {$this->arguments[7]})";
        }
        return $columns === null || $columns === [] ? $line : $line . " $list (" . implode(', ', $columns) . ')';
    }
}
