<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** `<name> <type> [null] [identity] [default <value>]`; the default is its canonical literal text or `now`. */
final class Column
{
    /** @param list<string> $comments */
    public function __construct(
        public string $name,
        public ColumnType $type,
        public bool $nullable,
        public bool $identity,
        public ?string $default,
        public array $comments = [],
    ) {
    }
}
