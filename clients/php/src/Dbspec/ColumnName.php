<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** The source table and column of `allow drop column <table>.<name>`. */
final readonly class ColumnName
{
    public function __construct(public string $table, public string $name)
    {
    }
}
