<?php
declare(strict_types=1);

namespace Orm\Dbspec;

final class Table
{
    /** @var list<Column> */
    public array $columns = [];
    public ?PrimaryKey $primaryKey = null;
    /** @var list<UniqueKey> */
    public array $uniqueKeys = [];
    /** @var list<Index> */
    public array $indexes = [];
    /** @var list<ForeignKey> */
    public array $foreignKeys = [];
    /** @var list<Check> */
    public array $checks = [];
    public ?Settings $settings = null;
    /** @var list<string> Comment lines before the closing brace. */
    public array $closingComments = [];

    /** @param list<string> $comments */
    public function __construct(public string $name, public array $comments = [])
    {
    }
}
