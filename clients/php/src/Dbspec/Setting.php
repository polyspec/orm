<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * One setting line. The kind is one of KINDS, in canonical order; the
 * arguments are the names the line lists: `audit` holds the history table,
 * operation, action and previous columns in that order.
 *
 * audit의 exclude와 include는 기록하지 않는 column과 operation column 말고 기록하는
 * column의 목록이며, 목록이 없으면 null이다. parse한 setting은 둘 중 하나만 가진다
 * (docs/dbspec.md "Audit").
 */
final class Setting
{
    public const KINDS = ['entity', 'updated', 'soft_delete', 'select_explicit', 'codec', 'aes_version', 'blind_index', 'navigation', 'immutable', 'audit'];
    public const CODEC_STAGES = ['ordered_json', 'aes', 'hex', 'gz', 'base64', 'serialize', 'yaml', 'ip'];

    /**
     * @param list<string> $arguments
     * @param list<string> $comments
     * @param list<string>|null $exclude
     * @param list<string>|null $include
     */
    public function __construct(
        public string $kind,
        public array $arguments,
        public array $comments = [],
        public ?array $exclude = null,
        public ?array $include = null,
    ) {
    }

    /**
     * audit trigger가 column을 복사하는지 알린다. operation column은 언제나, exclude 목록의
     * column은 언제나 아니며, include 목록이 있으면 그 column만 복사한다.
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
     * audit trigger가 복사하지 않는 table의 column을 column 순서로 돌려준다. schema text가 쓰는
     * 목록이다.
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
     * audit setting 줄이다. 목록이 비면 목록 없이, 아니면 list keyword와 그 column을 쓴다.
     *
     * @param list<string>|null $columns
     */
    public function auditLine(string $list, ?array $columns): string
    {
        [$history, $operation, $action, $previous] = $this->arguments;
        $line = "audit into $history operation $operation action $action previous $previous";
        return $columns === null || $columns === [] ? $line : $line . " $list (" . implode(', ', $columns) . ')';
    }
}
