<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** A dbspec type: `i16`, `decimal(13,2)`, `varchar(64)`, `time(0)` and the others of the type table. */
final readonly class ColumnType
{
    public const SIMPLE = ['i16', 'i32', 'i64', 'bool', 'f64', 'text', 'bytes', 'uuid', 'date'];
    /** Parameter count of each parameterized type. */
    public const PARAMETERIZED = ['decimal' => 2, 'varchar' => 1, 'time' => 1, 'datetime' => 1];

    /** @param list<int> $parameters */
    public function __construct(public string $name, public array $parameters = [])
    {
    }

    public function text(): string
    {
        return $this->parameters === [] ? $this->name : $this->name . '(' . implode(',', $this->parameters) . ')';
    }

    public function isInteger(): bool
    {
        return $this->name === 'i16' || $this->name === 'i32' || $this->name === 'i64';
    }
}
